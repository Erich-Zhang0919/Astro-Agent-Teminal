import { randomUUID } from 'node:crypto'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import {
    BaseMessage,
    SystemMessage,
} from '@langchain/core/messages'
import {
    BaseCheckpointSaver,
    END,
    GraphNode,
    MessagesValue,
    START,
    StateGraph,
    StateSchema,
    UntrackedValue,
} from '@langchain/langgraph'
import type * as LangGraphPrebuilt from '@langchain/langgraph/dist/prebuilt'
import { z } from 'zod'

// The package exports this subpath at runtime, but the project's legacy
// `moduleResolution: node` setting cannot discover its conditional types entry.
const { ToolNode, toolsCondition } = require(
    '@langchain/langgraph/prebuilt',
) as typeof LangGraphPrebuilt

export type HistoryPreprocessor = (
    messages: readonly BaseMessage[],
) => BaseMessage[] | Promise<BaseMessage[]>

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
    preprocessedMessages: new UntrackedValue<BaseMessage[]>(),
    sourceMessageIds: new UntrackedValue<string[]>(),
})

const AgentContext = z.object({
    preprocessMessages: z.custom<HistoryPreprocessor>().optional(),
})

/**
 * 构建一个带有单次、非持久化消息预处理步骤的 ReAct agent 图。
 *
 * `messages` 是 checkpoint 中的 canonical history；`preprocessedMessages`
 * 只在当前 graph run 中存在。工具循环期间产生的新消息会在每次模型调用前
 * 重新追加到预处理后的基础上下文中。
 */
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

    const preprocess: GraphNode<typeof AgentState, AgentGraphContext> = async (state, config) => {
        const sourceMessages = [...state.messages]
        const sourceMessageIds = sourceMessages.map((message) => {
            if (!message.id) message.id = randomUUID()
            return message.id
        })
        const preprocessMessages = config.context?.preprocessMessages
        const preprocessedMessages = preprocessMessages
            ? await preprocessMessages(sourceMessages)
            : sourceMessages

        return {
            preprocessedMessages: [...preprocessedMessages],
            sourceMessageIds,
        }
    }

    const callModel: GraphNode<typeof AgentState, AgentGraphContext> = async (state, config) => {
        const sourceMessageIds = new Set(state.sourceMessageIds)
        const messagesCreatedDuringRun = state.messages.filter(
            (message) => !message.id || !sourceMessageIds.has(message.id),
        )
        const response = await modelWithTools.invoke(
            [
                systemMessage,
                ...state.preprocessedMessages,
                ...messagesCreatedDuringRun,
            ],
            config,
        )

        return { messages: [response] }
    }

    return new StateGraph(AgentState, AgentContext)
        .addNode('preprocess', preprocess)
        .addNode('model_request', callModel)
        .addNode('tools', new ToolNode(tools))
        .addEdge(START, 'preprocess')
        .addEdge('preprocess', 'model_request')
        .addConditionalEdges('model_request', toolsCondition, ['tools', END])
        .addEdge('tools', 'model_request')
        .compile({ checkpointer })
}
