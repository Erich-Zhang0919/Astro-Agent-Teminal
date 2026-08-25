import { createAgent, ReactAgent } from 'langchain'
import { ChatOpenAI } from '@langchain/openai'
import { tools } from './tools'
import { discoverSkills, getSkillsListText } from './skills'
import { checkpointer } from './session-store'
import { AgentRunResult, collectAgentStream } from './context-usage'
import { getModelContextWindow } from './model-metadata'

// ── Model ──────────────────────────────────────────────────
const MODEL_ID = 'kimi-k2.6'
const API_BASE_URL = 'https://api.moonshot.cn/v1'

const model = new ChatOpenAI({
    model: MODEL_ID,
    apiKey: process.env.MOONSHOT_API_KEY,
    configuration: { baseURL: API_BASE_URL },
    streaming: true,
    streamUsage: true,
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
 * @returns {Promise<AgentRunResult>} 完整回复及最后一次模型调用的 context 信息
 */
export async function runAgentStream(
    userMessage: string,
    onToken: (token: string) => void,
    threadId: string = 'default-session',
    signal?: AbortSignal,
): Promise<AgentRunResult> {
    const config = { configurable: { thread_id: threadId } }
    const configuredContextWindow = getModelContextWindow(MODEL_ID, {
        apiKey: process.env.MOONSHOT_API_KEY,
        baseUrl: API_BASE_URL,
    })

    const stream = await agent.stream(
        { messages: [{ role: 'user', content: userMessage }] },
        { ...config, streamMode: 'messages', signal },
    )

    const result = await collectAgentStream(
        stream as AsyncIterable<unknown>,
        onToken,
        MODEL_ID,
        signal,
    )

    if (signal?.aborted) return result

    const contextWindow = result.modelId === MODEL_ID
        ? await configuredContextWindow
        : await getModelContextWindow(result.modelId, {
            apiKey: process.env.MOONSHOT_API_KEY,
            baseUrl: API_BASE_URL,
        })

    return { ...result, contextWindow }
}
