import { createAgent, ReactAgent } from 'langchain'
import { ChatOpenAI } from '@langchain/openai'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { tools } from './tools'
import { discoverSkills, getSkillsListText } from './skills'

// ── Model ──────────────────────────────────────────────────
const model = new ChatOpenAI({
    model: 'kimi-k2.6',
    apiKey: process.env.MOONSHOT_API_KEY,
    configuration: { baseURL: 'https://api.moonshot.cn/v1' },
    streaming: true,
    modelKwargs: { thinking: { type: 'disabled' } },  // 关闭 thinking
})

// ── Skills ────────────────────────────────────────────────────
discoverSkills()

const systemPrompt = `You are a helpful assistant.

## Skills (mandatory routing)

The skills listed below are REAL and available to you right now. They are NOT hypothetical.

Before you do anything else for a user request — and before calling any other tool such as search/web_search/tavily_search — you MUST first check whether the request matches a skill's description below. If it matches:

1. Call the \`load_skill\` tool with the skill's exact name to load its full instructions. Load at most one skill per call.
2. Follow the loaded SKILL.md instructions to complete the task.

Only fall back to general tools (web search, etc.) when NO skill matches, or when the loaded skill tells you to. Never claim a skill does not exist if it appears in the list below.

Available skills:
${getSkillsListText()}`

// ── Agent & Memory ────────────────────────────────────────────
const checkpointerPath = resolve(process.cwd(), '.data', 'checkpointer.db')
mkdirSync(dirname(checkpointerPath), { recursive: true })

const checkpointer = SqliteSaver.fromConnString(checkpointerPath)

export const agent: ReactAgent = createAgent({
    model,
    tools,
    systemPrompt,
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
