import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { ToolCall } from '@langchain/core/messages/tool'
import { randomUUID } from 'node:crypto'
import {
    AIMessage,
    BaseMessage,
    HumanMessage,
    isAIMessage,
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
import { permissionLevelOf } from './permission/util'
import { HookEngine, HookInjection, hookInjections } from './hooks/engine'
import { emitToolEvent, ToolEventCallback } from './tool-events'

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
}

export interface AgentGraphContext extends Record<string, unknown> {
    runSubAgent?: (prompt: string) => Promise<string>
    preprocessMessages?: HistoryPreprocessor
    hooks?: HookEngine
    hookMessages?: () => HookInjection[] | Promise<HookInjection[]>
    onToolEvent?: ToolEventCallback
}

type PendingToolUpdate =
    | { kind: 'update'; value: Record<string, unknown> }
    | { kind: 'command'; value: ReturnType<Command['toJSON']> & { graph?: string } }

type HookToolCall = {
    name: string
    id?: string
    args: Record<string, unknown>
}

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
})

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

    const modelWithTools = model.bindTools(tools)
    const systemMessage = new SystemMessage(systemPrompt)
    const toolByName = new Map(tools.map((item) => [item.name, item]))

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
        const response = await modelWithTools.invoke([systemMessage, ...messages], config)
        return { messages: [...injections, response], pendingHookMessages: [] }
    }

    const reviewTools: GraphNode<typeof AgentState, AgentGraphContext> = (state) => {
        const lastMessage = state.messages[state.messages.length - 1]
        if (!lastMessage || !isAIMessage(lastMessage)) {
            throw new Error('Tool approval requires an AI message.')
        }

        const toolCalls = lastMessage.tool_calls ?? []
        // The node restarts after each interrupt. No tool can run until all
        // decisions have been collected and checkpointed.
        const decisions = toolCalls.map((call, index) => {
            const level = permissionLevelOf(toolByName.get(call.name))
            const permission = level === 'read' ? decideReadPermission(call.args)
                : level === 'write' ? decideWritePermission(call.args)
                    : level === 'exec' ? (call.name === 'agent_tool'
                        ? { kind: 'confirm' as const } : decideExecPermission(call.args))
                        : level === 'network' ? decideNetworkPermission(call.args)
                            : { kind: 'allow' as const }
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
            }).approved === true
            return { approved, blockedReason: null }
        })
        return {
            approvalDecisions: decisions.map((decision) => decision.approved),
            blockedReasons: decisions.map((decision) => decision.blockedReason),
            hookBatchId: randomUUID(),
            hookCalls: toolCalls,
            hookUpdates: [],
        }
    }

    const preToolHooks: GraphNode<typeof AgentState, AgentGraphContext> = async (state, config) => {
        const approvals = [...state.approvalDecisions]
        const reasons = [...state.blockedReasons]
        const injections = [...state.pendingHookMessages]
        const hooks = config.context?.hooks
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
    const toolExecutor = new ObservedToolNode(tools)
    const toolNode: GraphNode<typeof AgentState, AgentGraphContext> = async (state, config) => {
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
            return { hookUpdates: [{ kind: 'update' as const,
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
        return { hookUpdates: updates.map((update): PendingToolUpdate => isCommand(update)
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
        return [...updates, hookState] as Awaited<ReturnType<typeof toolExecutor.invoke>>
    }

    return new StateGraph(AgentState, AgentContext)
        .addNode('model_request', callModel)
        .addNode('review_tools', reviewTools)
        .addNode('pre_tool_hooks', preToolHooks)
        .addNode('tools', toolNode)
        .addNode('post_tool_hooks', postToolHooks)
        .addEdge(START, 'model_request')
        .addConditionalEdges('model_request', (state) =>
            toolsCondition(state) === 'tools' ? 'review_tools' : END,
        ['review_tools', END])
        .addEdge('review_tools', 'pre_tool_hooks')
        .addEdge('pre_tool_hooks', 'tools')
        .addEdge('tools', 'post_tool_hooks')
        .addEdge('post_tool_hooks', 'model_request')
        .compile({ checkpointer })
}
