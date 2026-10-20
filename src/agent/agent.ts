import { randomUUID } from 'node:crypto'
import { isAIMessage, type BaseMessage } from '@langchain/core/messages'
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons'
import { MemorySaver } from '@langchain/langgraph'
import { tools } from './tools'
import { checkpointer, sessionStore } from './session-store'
import {
    AgentRunResult,
    ContextCompactionResult,
    applyCompactedContext,
    compactContext,
    isCompactionRecordValidForMessages,
} from './context-usage'
import { getModelContextWindow } from './model-metadata'
import { createModels } from './model'
import { createAgentGraph, CreateAgentGraphOptions, HistoryPreprocessor, ToolApprovalRequest } from './agent-graph'
import { ContextCompactionStore } from './context-compaction-store'
import { systemPrompt, delegationPrompt } from './prompt'
import { runGraphWithApprovals } from './agent-runner'
import { HookEngine, HookSessions, HookSessionOptions, SessionEndReason, HookEventCallback } from './hooks/engine'
import { HookContextStore, MemoryHookContextStore } from './hooks/context-store'
import type { ToolEventCallback } from './tool-events'
import { SubAgentQueue } from './subagent-queue'
import { loadMcpConfiguration } from './mcp/config'
import { McpManager } from './mcp/manager'
import type { McpServerStatus } from './mcp/types'

export { HistoryPreprocessor, ToolApprovalRequest } from './agent-graph'
export type { ToolExecutionEvent, ToolEventCallback } from './tool-events'
export type { HookExecutionEvent, HookEventCallback } from './hooks/engine'

export interface RunAgentOptions {
    preprocessMessages?: HistoryPreprocessor
    confirmTool?: (request: ToolApprovalRequest) => Promise<boolean>
    hooksPath?: string
    onHookDiagnostic?: (message: string) => void
    onHookEvent?: HookEventCallback
    onToolEvent?: ToolEventCallback
    mcpConfigPath?: string
    onMcpDiagnostic?: (message: string) => void
}

const { config: modelConfig, model, compactionModel } = createModels()

// ── Agent & Memory ────────────────────────────────────────────
function createRuntime(isSubAgent: boolean, inheritedHooks?: HookEngine, inheritedMcp?: McpManager) {
    const inbox = isSubAgent ? new MemoryHookContextStore() : new HookContextStore()
    const saver = isSubAgent ? new MemorySaver() : checkpointer
    const availableTools = [...tools, ...inheritedMcp?.tools ?? []] as unknown as CreateAgentGraphOptions['tools']
    const toolset = isSubAgent ? availableTools.filter(item => item.name !== 'agent_tool') : availableTools
    const graph = createAgentGraph({
        model,
        tools: toolset,
        systemPrompt: isSubAgent ? systemPrompt : `${systemPrompt}\n\n${delegationPrompt}`,
        checkpointer: saver,
    })
    return { graph, inbox, saver, sessions: new HookSessions(inbox, inheritedHooks), isSubAgent, inheritedMcp, toolset }
}

type AgentRuntime = ReturnType<typeof createRuntime>
const mainRuntime = createRuntime(false)
const subAgentQueue = new SubAgentQueue()
export const agent = mainRuntime.graph
const mcpSessions = new Map<string, Promise<{ manager: McpManager; toolset: CreateAgentGraphOptions['tools'] }>>()
const endingSessions = new Map<string, Promise<void>>()

export const contextCompactionStore = new ContextCompactionStore()

export async function startAgentSession(
    threadId: string,
    options: RunAgentOptions & HookSessionOptions = {},
): Promise<void> {
    if (!threadId) throw new Error('A thread ID is required to start an agent session.')
    options.signal?.throwIfAborted()
    await endingSessions.get(threadId)
    const existing = mcpSessions.get(threadId)
    if (existing) {
        await existing
        options.signal?.throwIfAborted()
        return
    }
    const activation = (async () => {
        const configuration = await loadMcpConfiguration(process.cwd(), options.mcpConfigPath)
        const manager = new McpManager(configuration, options.onMcpDiagnostic)
        let hooksStarted = false
        try {
            await mainRuntime.sessions.start(threadId, options)
            hooksStarted = true
            await manager.start(options.signal)
            return { manager, toolset: [...tools, ...manager.tools] as unknown as CreateAgentGraphOptions['tools'] }
        } catch (error) {
            try { if (hooksStarted) await mainRuntime.sessions.end(threadId, 'error') }
            finally { await manager.close() }
            throw error
        }
    })()
    mcpSessions.set(threadId, activation)
    try { await activation } catch (error) {
        if (mcpSessions.get(threadId) === activation) mcpSessions.delete(threadId)
        throw error
    }
}

export async function endAgentSession(threadId: string, reason: SessionEndReason): Promise<void> {
    const existing = endingSessions.get(threadId)
    if (existing) return existing
    const activation = mcpSessions.get(threadId)
    if (!activation) return mainRuntime.sessions.end(threadId, reason)
    const completion = (async () => {
        const { manager } = await activation
        try { await mainRuntime.sessions.end(threadId, reason) }
        finally { await manager.close() }
    })()
    endingSessions.set(threadId, completion)
    try { await completion } finally {
        if (mcpSessions.get(threadId) === activation) mcpSessions.delete(threadId)
        endingSessions.delete(threadId)
    }
}

export async function getMcpSessionStatus(threadId: string): Promise<McpServerStatus[]> {
    const activation = mcpSessions.get(threadId)
    return activation ? (await activation).manager.getStatus() : []
}

export async function compactAgentContext(threadId: string): Promise<ContextCompactionResult> {
    const [messages, previousRecord] = await Promise.all([
        sessionStore.getMessages(threadId),
        contextCompactionStore.get(threadId),
    ])
    const result = await compactContext(messages, previousRecord, compactionModel)

    if (result.status === 'compacted') {
        await contextCompactionStore.set(threadId, result.record)
    } else if (result.cacheWasInvalidated) {
        await contextCompactionStore.delete(threadId)
    }

    return result
}

/**
 * 以流式方式运行 agent，将 token 逐个回调给调用方
 * @param {string} userMessage - 当前用户输入（历史已由 checkpointer 自动续接）
 * @param {Function} onToken   - 每个 token 到来时的回调 (token: string) => void
 * @param {string} threadId    - 会话 ID，相同 ID 自动续上历史记录
 * @param {AbortSignal} signal  - 可选的取消信号
 * @param {RunAgentOptions} options - 可选的本轮历史消息预处理配置
 * @returns {Promise<AgentRunResult>} 完整回复及最后一次模型调用的 context 信息
 */
export async function runAgentStream(
    userMessage: string,
    onToken: (token: string) => void,
    threadId: string = 'default-session',
    signal?: AbortSignal,
    options: RunAgentOptions = {},
): Promise<AgentRunResult> {
    return runAgent(mainRuntime, userMessage, onToken, threadId, signal, options)
}

/** Both roles enter through the same session lifecycle, ReAct graph and approval loop. */
async function runAgent(
    runtime: AgentRuntime,
    userMessage: string,
    onToken: (token: string) => void,
    threadId: string,
    signal: AbortSignal | undefined,
    options: RunAgentOptions,
): Promise<AgentRunResult> {
    if (runtime.isSubAgent) await runtime.sessions.start(threadId, { ...options, signal })
    else await startAgentSession(threadId, { ...options, signal })
    const mcpSession = runtime.isSubAgent ? undefined : await mcpSessions.get(threadId)
    const manager = runtime.inheritedMcp ?? mcpSession?.manager
    const toolset = mcpSession?.toolset ?? runtime.toolset
    const hooks = await runtime.sessions.get(threadId)
    const cachedCompaction = runtime.isSubAgent ? undefined : await contextCompactionStore.get(threadId)
    const preprocessMessages: HistoryPreprocessor | undefined = runtime.isSubAgent ? undefined : async (messages) => {
        const cachedRecordIsValid = cachedCompaction !== undefined &&
            isCompactionRecordValidForMessages(cachedCompaction, messages)
        if (cachedCompaction && !cachedRecordIsValid) {
            await contextCompactionStore.delete(threadId)
        }

        const compactedMessages = applyCompactedContext(
            messages,
            cachedRecordIsValid ? cachedCompaction : undefined,
        )
        return options.preprocessMessages
            ? options.preprocessMessages(compactedMessages)
            : compactedMessages
    }
    const config = {
        configurable: { thread_id: threadId },
        context: { preprocessMessages, hooks, onToolEvent: options.onToolEvent, toolset,
            hookMessages: () => runtime.inbox.get(threadId),
            runSubAgent: runtime.isSubAgent ? undefined : (prompt: string) => subAgentQueue.run(
                threadId, () => runSubAgent(prompt, signal, options, hooks, manager), signal,
            ) },
    }
    let result: Awaited<ReturnType<typeof runGraphWithApprovals>>
    try {
        result = await runGraphWithApprovals(
            runtime.graph, userMessage, onToken, config, modelConfig.model, signal, options.confirmTool,
        )
    } finally {
        // Only acknowledge inbox messages that made it into a durable checkpoint.
        // Stable IDs also suppress duplicates if the process exits before this cleanup.
        const snapshot = await runtime.graph.getState(config)
        const messages = (snapshot.values.messages ?? []) as BaseMessage[]
        const ids = new Set(messages.map(message => message.id))
        runtime.inbox.acknowledge(threadId, runtime.inbox.get(threadId)
            .filter(injection => ids.has(injection.id)).map(injection => injection.id))
    }

    if (signal?.aborted || runtime.isSubAgent) return result

    const configuredContextWindow = getModelContextWindow(modelConfig.model, {
        apiKey: modelConfig.apiKey,
        baseUrl: modelConfig.baseURL,
    })
    const contextWindow = result.modelId === modelConfig.model
        ? await configuredContextWindow
        : await getModelContextWindow(result.modelId, {
            apiKey: modelConfig.apiKey,
            baseUrl: modelConfig.baseURL,
        })

    return { ...result, contextWindow }
}

async function runSubAgent(
    prompt: string,
    signal: AbortSignal | undefined,
    options: RunAgentOptions,
    hooks: HookEngine,
    mcp?: McpManager,
): Promise<string> {
    // LangGraph otherwise inherits the ambient parent's checkpoint and callbacks,
    // even when a fresh thread_id is explicitly supplied to the child graph.
    return AsyncLocalStorageProviderSingleton.runWithConfig({}, async () => {
        signal?.throwIfAborted()
        const runtime = createRuntime(true, hooks, mcp)
        const threadId = `subagent-${randomUUID()}`
        const { confirmTool, hooksPath, onHookDiagnostic, onHookEvent, onToolEvent } = options
        let completed = false
        try {
            await runAgent(runtime, prompt, () => undefined, threadId, signal,
                { confirmTool, hooksPath, onHookDiagnostic, onHookEvent, onToolEvent })
            signal?.throwIfAborted()
            const snapshot = await runtime.graph.getState({ configurable: { thread_id: threadId } })
            const finalMessage = (snapshot.values.messages as BaseMessage[]).at(-1)
            if (!finalMessage || !isAIMessage(finalMessage) || finalMessage.tool_calls?.length) {
                throw new Error('SubAgent finished without a final response.')
            }
            const text = typeof finalMessage.content === 'string' ? finalMessage.content
                : finalMessage.content.flatMap(block => block.type === 'text' && typeof block.text === 'string'
                    ? [block.text] : []).join('')
            if (!text.trim()) throw new Error('SubAgent returned an empty final response.')
            completed = true
            return text
        } finally {
            try {
                await runtime.sessions.end(threadId, completed ? 'ask_completed' : 'error')
            } finally {
                if (runtime.inbox instanceof MemoryHookContextStore) runtime.inbox.clear()
                await runtime.saver.deleteThread(threadId)
            }
        }
    })
}
