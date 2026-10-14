import { ChatOpenAI } from '@langchain/openai'
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
import { createAgentGraph, HistoryPreprocessor, ToolApprovalRequest } from './agent-graph'
import { ContextCompactionStore } from './context-compaction-store'
import { systemPrompt } from './prompt'
import { runGraphWithApprovals } from './agent-runner'
import { HookSessions, HookSessionOptions, SessionEndReason, HookEventCallback } from './hooks/engine'
import { HookContextStore } from './hooks/context-store'
import type { ToolEventCallback } from './tool-events'

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
}

// ── Model ──────────────────────────────────────────────────
const MODEL_ID = 'kimi-k2.6'
const API_BASE_URL = 'https://api.moonshot.cn/v1'

const sharedModelOptions = {
    model: MODEL_ID,
    apiKey: process.env.MOONSHOT_API_KEY,
    configuration: { baseURL: API_BASE_URL },
    modelKwargs: { thinking: { type: 'disabled' } },  // 关闭 thinking
}

const model = new ChatOpenAI({
    ...sharedModelOptions,
    streaming: true,
    streamUsage: true,
})

const compactionModel = new ChatOpenAI({
    ...sharedModelOptions,
    streaming: false,
})

// ── Agent & Memory ────────────────────────────────────────────
export const agent = createAgentGraph({
    model,
    tools,
    systemPrompt,
    checkpointer,
})

export const contextCompactionStore = new ContextCompactionStore()
const hookContextStore = new HookContextStore()
const hookSessions = new HookSessions(hookContextStore)

export async function startAgentSession(
    threadId: string,
    options: RunAgentOptions & HookSessionOptions = {},
): Promise<void> {
    await hookSessions.start(threadId, options)
}

export async function endAgentSession(threadId: string, reason: SessionEndReason): Promise<void> {
    await hookSessions.end(threadId, reason)
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
    await startAgentSession(threadId, { ...options, signal })
    const hooks = await hookSessions.get(threadId)
    const cachedCompaction = await contextCompactionStore.get(threadId)
    const preprocessMessages: HistoryPreprocessor = async (messages) => {
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
        context: { preprocessMessages, hooks, onToolEvent: options.onToolEvent,
            hookMessages: () => hookContextStore.get(threadId) },
    }
    let result: Awaited<ReturnType<typeof runGraphWithApprovals>>
    try {
        result = await runGraphWithApprovals(
            agent, userMessage, onToken, config, MODEL_ID, signal, options.confirmTool,
        )
    } finally {
        // Only acknowledge inbox messages that made it into a durable checkpoint.
        // Stable IDs also suppress duplicates if the process exits before this cleanup.
        const messages = await sessionStore.getMessages(threadId)
        const ids = new Set(messages.map(message => message.id))
        hookContextStore.acknowledge(threadId, hookContextStore.get(threadId)
            .filter(injection => ids.has(injection.id)).map(injection => injection.id))
    }

    if (signal?.aborted) return result

    const configuredContextWindow = getModelContextWindow(MODEL_ID, {
        apiKey: process.env.MOONSHOT_API_KEY,
        baseUrl: API_BASE_URL,
    })
    const contextWindow = result.modelId === MODEL_ID
        ? await configuredContextWindow
        : await getModelContextWindow(result.modelId, {
            apiKey: process.env.MOONSHOT_API_KEY,
            baseUrl: API_BASE_URL,
        })

    return { ...result, contextWindow }
}
