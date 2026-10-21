import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { ToolCall } from '@langchain/core/messages/tool'
import { randomUUID } from 'node:crypto'
import {
    AIMessage,
    BaseMessage,
    HumanMessage,
    isAIMessage,
    isHumanMessage,
    SystemMessage,
    ToolMessage,
} from '@langchain/core/messages'
import {
    BaseCheckpointSaver,
    Command,
    END,
    GraphNode,
    interrupt,
    isCommand,
    isGraphInterrupt,
    LangGraphRunnableConfig,
    MessagesValue,
    START,
    StateGraph,
    StateSchema,
} from '@langchain/langgraph'
import type * as LangGraphPrebuilt from '@langchain/langgraph/dist/prebuilt'
import { z } from 'zod'
import { maybePersistedOutput } from './tools'
import { decideReadPermission } from './permission/read'
import { decideWritePermission } from './permission/write'
import { decideExecPermission } from './permission/exec'
import { decideNetworkPermission } from './permission/network'
import { permissionLevelOf, type PermissionDecision } from './permission/util'
import { McpBinding, mcpBindingMatches, mcpMetadata } from './mcp/types'
import { HookEngine, HookInjection, hookInjections } from './hooks/engine'
import { emitToolEvent, ToolEventCallback } from './tool-events'
import { AGENT_RECURSION_LIMIT, MAX_TOOL_ROUNDS } from './agent-limits'

// The package exports this subpath at runtime, but the project's legacy
// `moduleResolution: node` setting cannot discover its conditional types entry.
const { ToolNode, toolsCondition } = require(
    '@langchain/langgraph/prebuilt',
) as typeof LangGraphPrebuilt

export type HistoryPreprocessor = (
    messages: readonly BaseMessage[],
) => BaseMessage[] | Promise<BaseMessage[]>

export interface ToolApprovalRequest {
    toolCallId?: string
    name: string
    args: Record<string, unknown>
    index: number
    total: number
    mcp?: McpBinding
}

export interface AgentGraphContext extends Record<string, unknown> {
    runSubAgent?: (prompt: string) => Promise<string>
    preprocessMessages?: HistoryPreprocessor
    hooks?: HookEngine
    hookMessages?: () => HookInjection[] | Promise<HookInjection[]>
    onToolEvent?: ToolEventCallback
    toolset?: AgentTool[]
}

type PendingToolUpdate =
    | { kind: 'update'; value: Record<string, unknown> }
    | { kind: 'command'; value: ReturnType<Command['toJSON']> & { graph?: string } }

type HookToolCall = {
    name: string
    id?: string
    args: Record<string, unknown>
    mcp?: McpBinding
}

type ToolReview = { permission: PermissionDecision; mcp?: McpBinding }

function messagesInUpdate(value: unknown): BaseMessage[] {
    if (!value || typeof value !== 'object') return []
    const messages = Array.isArray(value)
        ? value.find((entry) => Array.isArray(entry) && entry[0] === 'messages')?.[1]
        : (value as Record<string, unknown>).messages
    return messages === undefined ? [] : Array.isArray(messages) ? messages : [messages]
}

type AgentTool = ConstructorParameters<typeof ToolNode>[0][number]

export interface CreateAgentGraphOptions {
    model: BaseChatModel
    tools: AgentTool[]
    systemPrompt: string
    checkpointer: BaseCheckpointSaver
}

const AgentState = new StateSchema({
    messages: MessagesValue,
    approvalDecisions: z.array(z.boolean()).default([]),
    blockedReasons: z.array(z.string().nullable()).default([]),
    hookBatchId: z.string().default(''),
    hookCalls: z.array(z.custom<HookToolCall>()).default([]),
    pendingHookMessages: z.array(z.custom<HookInjection>()).default([]),
    hookUpdates: z.array(z.custom<PendingToolUpdate>()).default([]),
    toolReviews: z.array(z.custom<ToolReview>()).default([]),
    finishRequested: z.boolean().default(false),
})

function toolRoundsInCurrentTurn(messages: BaseMessage[]): number {
    let rounds = 0
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]
        // Hook injections use HumanMessage too, but do not start a new user turn.
        if (isHumanMessage(message) && !message.id?.startsWith('hook:')) break
        if (isAIMessage(message) && message.tool_calls?.length) rounds++
    }
    return rounds
}

const FINAL_ANSWER_PROMPT = new SystemMessage(
    'The tool budget for this request has been reached. Make no further tool calls. '
    + 'Answer the user now using the results already available. Clearly distinguish verified facts '
    + 'from missing information, and explain any limits. Do not invent results or claim unexecuted tools succeeded.',
)

const BUDGET_FALLBACK = '本次查询已达到工具调用上限，已停止继续调用工具。现有信息不足以生成完整答复，请缩小问题范围后重试。'

// Runtime callbacks are optional and never checkpointed. Keep old callers valid.
const AgentContext = z.object({}).passthrough()

/** The canonical history is checkpointed; model context is rebuilt after each resume. */
export function createAgentGraph({
    model,
    tools,
    systemPrompt,
    checkpointer,
}: CreateAgentGraphOptions) {
    if (!model.bindTools) {
        throw new Error('The configured chat model does not support bindTools().')
    }

    const systemMessage = new SystemMessage(systemPrompt)
    const bindings = new WeakMap<AgentTool[], {
        model: ReturnType<NonNullable<BaseChatModel['bindTools']>>
        byName: Map<string, AgentTool>
        executor: ObservedToolNode
    }>()
    const resolveTools = (config: LangGraphRunnableConfig<AgentGraphContext>) => {
        const available = config.context?.toolset ?? tools
        let binding = bindings.get(available)
        if (!binding) {
            binding = { model: model.bindTools!(available),
                byName: new Map(available.map(item => [item.name, item])),
                executor: new ObservedToolNode(available) }
            bindings.set(available, binding)
        }
        return binding
    }

    const callModel: GraphNode<typeof AgentState, AgentGraphContext> = async (state, config) => {
        const seen = new Set(state.messages.map((message) => message.id))
        const queued = [...await config.context?.hookMessages?.() ?? [],
            ...state.pendingHookMessages]
        const injections = queued.flatMap((injection) => {
            if (seen.has(injection.id)) return []
            seen.add(injection.id)
            return [new HumanMessage({
                id: injection.id,
                content: `[Hook context: ${injection.event}]\n${injection.text}`,
            })]
        })
        const history = [...state.messages, ...injections]
        const messages = config.context?.preprocessMessages
            ? await config.context.preprocessMessages(history)
            : history
        const finish = state.finishRequested || toolRoundsInCurrentTurn(state.messages) >= MAX_TOOL_ROUNDS
        // Invoke the unbound model to actually remove tools from the final request.
        let response: AIMessage = finish
            ? await model.invoke([systemMessage, ...messages, FINAL_ANSWER_PROMPT], config)
            : await resolveTools(config).model.invoke([systemMessage, ...messages], config)
        if (finish && (response.tool_calls?.length || !response.text.trim())) {
            response = new AIMessage(BUDGET_FALLBACK)
        }
        return { messages: [...injections, response], pendingHookMessages: [], finishRequested: false }
    }

    const reviewCall = (call: ToolCall, config: LangGraphRunnableConfig<AgentGraphContext>): ToolReview => {
        const item = resolveTools(config).byName.get(call.name)
        if (!item) return { permission: { kind: 'block', message: 'Tool is not registered in this session.' } }
        const level = permissionLevelOf(item)
        const metadata = mcpMetadata(item)
        if (level === 'mcp') {
            if (!metadata?.isAvailable()) return { permission: { kind: 'block', message: 'MCP tool is unavailable. Re-enter the session to reconnect.' } }
            const { serverId, toolName, bindingFingerprint } = metadata
            return { mcp: { serverId, toolName, bindingFingerprint },
                permission: { kind: metadata.autoApprove ? 'allow' : 'confirm' } }
        }
        return { permission: level === 'read' ? decideReadPermission(call.args)
            : level === 'write' ? decideWritePermission(call.args)
                : level === 'exec' ? (call.name === 'agent_tool'
                    ? { kind: 'confirm' } : decideExecPermission(call.args))
                    : level === 'network' ? decideNetworkPermission(call.args)
                        : { kind: 'allow' } }
    }

    // Persist decisions and MCP identities before interrupts; replay keeps the same
    // interrupt order even if a server disappears or its whitelist changes.
    const prepareTools: GraphNode<typeof AgentState, AgentGraphContext> = (state, config) => {
        const last = state.messages.at(-1)
        if (!last || !isAIMessage(last)) throw new Error('Tool review requires an AI message.')
        return { toolReviews: (last.tool_calls ?? []).map(call => reviewCall(call, config)) }
    }

    const reviewTools: GraphNode<typeof AgentState, AgentGraphContext> = (state, config) => {
        const lastMessage = state.messages[state.messages.length - 1]
        if (!lastMessage || !isAIMessage(lastMessage)) {
            throw new Error('Tool approval requires an AI message.')
        }

        const toolCalls = lastMessage.tool_calls ?? []
        // The node restarts after each interrupt. No tool can run until all
        // decisions have been collected and checkpointed.
        const decisions = toolCalls.map((call, index) => {
            const { permission, mcp } = state.toolReviews[index] ?? reviewCall(call, config)
            if (permission.kind === 'allow') {
                return { approved: true, blockedReason: null }
            }
            if (permission.kind === 'block') {
                return { approved: false, blockedReason: permission.message }
            }
            const approved = interrupt<ToolApprovalRequest, { approved: boolean }>({
                toolCallId: call.id,
                name: call.name,
                args: call.args,
                index: index + 1,
                total: toolCalls.length,
                ...(mcp ? { mcp } : {}),
            }).approved === true
            return { approved, blockedReason: null }
        })
        return {
            approvalDecisions: decisions.map((decision) => decision.approved),
            blockedReasons: decisions.map((decision) => decision.blockedReason),
            hookBatchId: randomUUID(),
            hookCalls: toolCalls.map((call, index) => ({ ...call,
                ...(state.toolReviews[index]?.mcp ? { mcp: state.toolReviews[index].mcp } : {}) })),
            hookUpdates: [],
        }
    }

    const preToolHooks: GraphNode<typeof AgentState, AgentGraphContext> = async (state, config) => {
        const approvals = [...state.approvalDecisions]
        const reasons = [...state.blockedReasons]
        const injections = [...state.pendingHookMessages]
        const hooks = config.context?.hooks
        for (const [index, call] of state.hookCalls.entries()) {
            if (approvals[index] && call.mcp && !mcpBindingMatches(call.mcp, resolveTools(config).byName.get(call.name))) {
                approvals[index] = false
                reasons[index] = 'MCP tool binding changed or is unavailable. Request a new tool call.'
            }
        }
        if (hooks) {
            for (const [index, call] of state.hookCalls.entries()) {
                if (!approvals[index]) continue
                const eventId = `${state.hookBatchId}:PreToolUse:${index}`
                const result = await hooks.run({
                    version: 1, event: 'PreToolUse', eventId,
                    sessionId: String(config.configurable?.thread_id ?? ''), cwd: hooks.cwd,
                    tool: { name: call.name, callId: call.id, args: call.args },
                }, config.signal)
                injections.push(...hookInjections('PreToolUse', eventId, result.injections))
                if (result.blocked) {
                    approvals[index] = false
                    reasons[index] = result.error ?? 'PreToolUse hook blocked this tool call.'
                }
            }
        }
        return { approvalDecisions: approvals, blockedReasons: reasons,
            pendingHookMessages: injections }
    }

    class ObservedToolNode extends ToolNode {
        protected async runTool(
            call: ToolCall, config: LangGraphRunnableConfig<AgentGraphContext>, state: unknown,
        ): Promise<ToolMessage | Command> {
            const info = { toolCallId: call.id, name: call.name, args: call.args }
            const notify = config.context?.onToolEvent
            await emitToolEvent(notify, { ...info, type: 'start' })
            try {
                const output = await super.runTool(call, config, state)
                const messages = ToolMessage.isInstance(output) ? [output]
                    : messagesInUpdate(output.update).filter(ToolMessage.isInstance)
                await emitToolEvent(notify, {
                    ...info, type: 'result',
                    status: messages.some(message => message.status === 'error') ? 'error' : 'success',
                    content: messages.length === 1 ? messages[0].content
                        : messages.length ? messages.map(message => message.content) : '(no output)',
                })
                return output
            } catch (error) {
                if (!isGraphInterrupt(error) && !config.signal?.aborted) {
                    await emitToolEvent(notify, { ...info, type: 'result', status: 'error',
                        content: error instanceof Error ? error.message : String(error) })
                }
                throw error
            }
        }
    }
    const toolNode: GraphNode<typeof AgentState, AgentGraphContext> = async (state, config) => {
        const toolExecutor = resolveTools(config).executor
        // Also guard checkpoints that already passed pre hooks before reconnection.
        const approvalDecisions = state.approvalDecisions.map((approved, index) => {
            const call = state.hookCalls[index]
            return approved && (!call?.mcp || mcpBindingMatches(call.mcp, resolveTools(config).byName.get(call.name)))
        })
        state = { ...state, approvalDecisions,
            blockedReasons: state.blockedReasons.map((reason, index) =>
                state.approvalDecisions[index] && !approvalDecisions[index]
                    ? 'MCP tool binding changed or is unavailable. Request a new tool call.' : reason) }
        const lastMessage = state.messages[state.messages.length - 1]
        if (!lastMessage || !isAIMessage(lastMessage)) {
            throw new Error('Tool execution requires an AI message.')
        }

        const toolCalls = lastMessage.tool_calls ?? []
        if (state.approvalDecisions.length !== toolCalls.length ||
            state.blockedReasons.length !== toolCalls.length) {
            throw new Error('Every tool call must have an approval decision.')
        }

        const rejectedMessages = toolCalls.flatMap((call, index) =>
            state.approvalDecisions[index] ? [] : [new ToolMessage({
                tool_call_id: call.id ?? '',
                name: call.name,
                status: 'error',
                content: state.blockedReasons[index] ??
                    'The user rejected this tool call. Do not retry it without a new user request.',
            })],
        )
        let rejectedIndex = 0
        for (const [index, call] of toolCalls.entries()) {
            if (state.approvalDecisions[index]) continue
            await emitToolEvent(config.context?.onToolEvent, {
                type: 'result', toolCallId: call.id, name: call.name, args: call.args,
                status: 'blocked', content: rejectedMessages[rejectedIndex++].content,
            })
        }
        if (rejectedMessages.length === toolCalls.length) {
            return { approvalDecisions, blockedReasons: state.blockedReasons,
                hookUpdates: [{ kind: 'update' as const,
                value: { messages: rejectedMessages } }] }
        }

        // Pass only approved calls. ToolNode does not skip calls without IDs,
        // so rejected ToolMessages alone are not an execution barrier.
        const approvedCalls = toolCalls.filter((_, index) => state.approvalDecisions[index])
        const approvedMessage = new AIMessage({
            content: lastMessage.content,
            tool_calls: approvedCalls,
        })
        const approvedIds = new Set(approvedCalls.map((call) => call.id))
        const executionHistory = state.messages.slice(0, -1).filter((message) =>
            !ToolMessage.isInstance(message) || !approvedIds.has(message.tool_call_id),
        )
        const result = await toolExecutor.invoke({
            ...state,
            messages: [...executionHistory, approvedMessage],
        }, config)
        // Defer all updates (including Commands) until post hooks have run. The raw
        // outputs are checkpointed here, so a post-hook failure cannot rerun tools.
        let updates = Array.isArray(result) ? result : [result]
        if (rejectedMessages.length > 0) {
            if (Array.isArray(result)) {
                updates = [...updates, ...rejectedMessages.map(message => ({ messages: [message] }))]
                const callOrder = (update: unknown) => {
                    const messages = messagesInUpdate(isCommand(update) ? update.update : update)
                        .filter(ToolMessage.isInstance)
                    const indexes = messages.map(message => toolCalls.findIndex(call =>
                        (call.id ?? '') === message.tool_call_id &&
                        (message.name === undefined || message.name === call.name)))
                        .filter(index => index >= 0)
                    return indexes.length ? Math.min(...indexes) : toolCalls.length
                }
                updates.sort((left, right) => callOrder(left) - callOrder(right))
            }
            else {
                const approvedMessages = result.messages as ToolMessage[]
                let approvedIndex = 0
                let rejectedIndex = 0
                updates = [{ ...result,
                    messages: toolCalls.map((_, index) => state.approvalDecisions[index]
                        ? approvedMessages[approvedIndex++]
                        : rejectedMessages[rejectedIndex++]),
                }]
            }
        }
        return { approvalDecisions, blockedReasons: state.blockedReasons,
            hookUpdates: updates.map((update): PendingToolUpdate => isCommand(update)
            ? { kind: 'command', value: { ...update.toJSON(), graph: update.graph } }
            : { kind: 'update', value: update as Record<string, unknown> }) }
    }

    const postToolHooks: GraphNode<typeof AgentState, AgentGraphContext> = async (state, config) => {
        const injections = [...state.pendingHookMessages]
        const hooks = config.context?.hooks
        const rawMessages = state.hookUpdates.flatMap((update) =>
            messagesInUpdate(update.kind === 'command' ? update.value.update : update.value),
        ).filter(ToolMessage.isInstance)
        const remaining = [...rawMessages]
        const replacements = new Map<ToolMessage, ToolMessage>()
        for (const [index, call] of state.hookCalls.entries()) {
            if (!state.approvalDecisions[index]) continue
            const messageIndex = remaining.findIndex((message) =>
                message.tool_call_id === (call.id ?? '') &&
                (message.name === undefined || message.name === call.name))
            if (messageIndex < 0) continue
            const [message] = remaining.splice(messageIndex, 1)
            if (hooks) {
                const eventId = `${state.hookBatchId}:PostToolUse:${index}`
                const result = await hooks.run({
                    version: 1, event: 'PostToolUse', eventId,
                    sessionId: String(config.configurable?.thread_id ?? ''), cwd: hooks.cwd,
                    tool: { name: call.name, callId: call.id, args: call.args },
                    result: { status: message.status ?? 'success', content: message.content },
                }, config.signal)
                injections.push(...hookInjections('PostToolUse', eventId, result.injections))
            }
            if (typeof message.content === 'string') {
                replacements.set(message, new ToolMessage({ ...message,
                    content: await maybePersistedOutput(message.content, message.tool_call_id) }))
            }
        }
        const replaceMessages = (value: unknown): unknown => {
            const replace = (messages: unknown) => Array.isArray(messages)
                ? messages.map((message) => replacements.get(message) ?? message)
                : replacements.get(messages as ToolMessage) ?? messages
            if (Array.isArray(value)) return value.map((entry) =>
                Array.isArray(entry) && entry[0] === 'messages'
                    ? ['messages', replace(entry[1])] : entry)
            if (value && typeof value === 'object' && 'messages' in value) {
                return { ...value, messages: replace(value.messages) }
            }
            return value
        }
        const updates = state.hookUpdates.map((update) => update.kind === 'command'
            ? new Command({ ...update.value,
                update: replaceMessages(update.value.update) as Command['update'] })
            : replaceMessages(update.value) as Record<string, unknown>)
        const hookState = { pendingHookMessages: injections, hookUpdates: [] }
        if (!updates.some(isCommand)) return { ...updates[0], ...hookState }
        // ToolNode supports mixed update/Command arrays, although GraphNode's
        // declared return type omits them in this version of LangGraph.
        return [...updates, hookState] as Awaited<ReturnType<ObservedToolNode['invoke']>>
    }

    return new StateGraph(AgentState, AgentContext)
        .addNode('model_request', callModel)
        .addNode('prepare_tools', prepareTools)
        .addNode('review_tools', reviewTools)
        .addNode('pre_tool_hooks', preToolHooks)
        .addNode('tools', toolNode)
        .addNode('post_tool_hooks', postToolHooks)
        .addEdge(START, 'model_request')
        .addConditionalEdges('model_request', (state) =>
            toolsCondition(state) === 'tools' ? 'prepare_tools' : END,
        ['prepare_tools', END])
        .addEdge('prepare_tools', 'review_tools')
        .addEdge('review_tools', 'pre_tool_hooks')
        .addEdge('pre_tool_hooks', 'tools')
        .addEdge('tools', 'post_tool_hooks')
        .addEdge('post_tool_hooks', 'model_request')
        .compile({ checkpointer })
        .withConfig({ recursionLimit: AGENT_RECURSION_LIMIT })
}
