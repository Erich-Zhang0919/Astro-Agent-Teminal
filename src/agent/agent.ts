import { createAgent, ReactAgent } from 'langchain'
import { ChatOpenAI } from '@langchain/openai'
import { MemorySaver } from '@langchain/langgraph'
import { tools } from './tools'

// ── Model ──────────────────────────────────────────────────
const model = new ChatOpenAI({
    model: 'kimi-k2.6',
    apiKey: process.env.MOONSHOT_API_KEY,
    configuration: { baseURL: 'https://api.moonshot.cn/v1' },
    streaming: true,
    modelKwargs: { thinking: { type: 'disabled' } },  // 关闭 thinking
})

// ── Agent & Memory ────────────────────────────────────────────
const checkpointer = new MemorySaver()

export const agent: ReactAgent = createAgent({
    model,
    tools,
    systemPrompt: 'You are a helpful assistant.',
    checkpointer,
})

/**
 * 以流式方式运行 agent，将 token 逐个回调给调用方
 * @param {string} userMessage - 当前用户输入（历史已由 checkpointer 自动续接）
 * @param {Function} onToken   - 每个 token 到来时的回调 (token: string) => void
 * @param {string} threadId    - 会话 ID，相同 ID 自动续上历史记录
 * @returns {Promise<string>}  完整的 AI 回复文本
 */
export async function runAgentStream(
    userMessage: string,
    onToken: (token: string) => void,
    threadId: string = 'default-session',
    signal?: AbortSignal,
): Promise<string> {
    const config = { configurable: { thread_id: threadId } }

    const stream = await agent.stream(
        { messages: [{ role: 'user', content: userMessage }] },
        { ...config, streamMode: 'messages', signal },
    )

    let fullResponse = ''

    for await (const chunk of stream as any) {
        if (signal?.aborted) break

        const message = chunk[0]
        const metadata = chunk[1]

        if (metadata?.langgraph_node !== 'model_request') continue

        // AIMessageChunk 的 content 在 message.content 属性上，不在 kwargs.content
        const content: string = (message as any).content ?? (message as any).kwargs?.content ?? ''
        const toolCallChunks = (message as any).tool_call_chunks ?? []

        if (!content || toolCallChunks.length > 0) continue

        onToken(content)
        fullResponse += content
    }

    return fullResponse
}