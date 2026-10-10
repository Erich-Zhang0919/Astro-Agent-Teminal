import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import {
    AIMessage,
    BaseMessage,
    isAIMessage,
    SystemMessage,
    ToolMessage,
} from '@langchain/core/messages'
import {
    BaseCheckpointSaver,
    END,
    GraphNode,
    interrupt,
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

export interface AgentGraphContext {
    preprocessMessages?: HistoryPreprocessor
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
})

const AgentContext = z.object({
    preprocessMessages: z.custom<HistoryPreprocessor>().optional(),
})

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
        const messages = config.context?.preprocessMessages
            ? await config.context.preprocessMessages(state.messages)
            : state.messages
        const response = await modelWithTools.invoke([systemMessage, ...messages], config)
        return { messages: [response] }
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
                    : level === 'exec' ? decideExecPermission(call.args)
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
        }
    }

    const toolExecutor = new ToolNode(tools)
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
        if (rejectedMessages.length === toolCalls.length) {
            return { messages: rejectedMessages }
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
        // ToolNode returns message updates, or a mixture of updates and Commands.
        const updates: unknown[] = Array.isArray(result) ? result : [result]
        for (const update of updates) {
            if (!update || typeof update !== 'object' || !('messages' in update) ||
                !Array.isArray(update.messages)) continue

            await Promise.all(update.messages.map(async (message: unknown) => {
                if (ToolMessage.isInstance(message) && typeof message.content === 'string') {
                    message.content = await maybePersistedOutput(message.content, message.tool_call_id)
                }
            }))
        }

        if (rejectedMessages.length === 0) return result
        if (Array.isArray(result)) return [...result, { messages: rejectedMessages }]

        const approvedMessages = result.messages as ToolMessage[]
        let approvedIndex = 0
        let rejectedIndex = 0
        return {
            ...result,
            messages: toolCalls.map((_, index) => state.approvalDecisions[index]
                ? approvedMessages[approvedIndex++]
                : rejectedMessages[rejectedIndex++]),
        }
    }

    return new StateGraph(AgentState, AgentContext)
        .addNode('model_request', callModel)
        .addNode('review_tools', reviewTools)
        .addNode('tools', toolNode)
        .addEdge(START, 'model_request')
        .addConditionalEdges('model_request', (state) =>
            toolsCondition(state) === 'tools' ? 'review_tools' : END,
        ['review_tools', END])
        .addEdge('review_tools', 'tools')
        .addEdge('tools', 'model_request')
        .compile({ checkpointer })
}
