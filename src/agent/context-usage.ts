export interface TokenUsage {
    inputTokens: number
    outputTokens: number
    totalTokens: number
}

export interface AgentRunResult {
    text: string
    modelId: string
    usage?: TokenUsage
    contextWindow?: number
}

interface StreamMessage {
    content?: unknown
    kwargs?: {
        content?: unknown
        usage_metadata?: unknown
        response_metadata?: unknown
    }
    tool_call_chunks?: unknown[]
    usage_metadata?: unknown
    response_metadata?: unknown
}

interface StreamMetadata {
    langgraph_node?: string
}

export async function collectAgentStream(
    stream: AsyncIterable<unknown>,
    onToken: (token: string) => void,
    configuredModelId: string,
    signal?: AbortSignal,
): Promise<Omit<AgentRunResult, 'contextWindow'>> {
    let text = ''
    let modelId = configuredModelId
    let usage: TokenUsage | undefined

    for await (const rawChunk of stream) {
        if (signal?.aborted) break
        if (!Array.isArray(rawChunk)) continue

        const message = rawChunk[0] as StreamMessage | undefined
        const metadata = rawChunk[1] as StreamMetadata | undefined

        if (!message || metadata?.langgraph_node !== 'model_request') continue

        const chunkModelId = extractModelId(message)
        if (chunkModelId) modelId = chunkModelId

        const chunkUsage = normalizeTokenUsage(
            message.usage_metadata ?? message.kwargs?.usage_metadata,
        )
        if (chunkUsage) usage = chunkUsage

        const content = message.content ?? message.kwargs?.content
        const toolCallChunks = message.tool_call_chunks ?? []

        if (typeof content !== 'string' || !content || toolCallChunks.length > 0) continue

        onToken(content)
        text += content
    }

    return { text, modelId, usage }
}

export function normalizeTokenUsage(value: unknown): TokenUsage | undefined {
    if (!value || typeof value !== 'object') return undefined

    const rawUsage = value as Record<string, unknown>
    const inputTokens = asTokenCount(rawUsage.input_tokens)
    const outputTokens = asTokenCount(rawUsage.output_tokens)

    if (inputTokens === undefined || outputTokens === undefined) return undefined

    return {
        inputTokens,
        outputTokens,
        totalTokens: asTokenCount(rawUsage.total_tokens) ?? inputTokens + outputTokens,
    }
}

export function formatContextUsage(result: AgentRunResult): string {
    const total = result.usage?.totalTokens
    const limit = validContextWindow(result.contextWindow)
        ? result.contextWindow
        : undefined
    const totalText = total === undefined ? 'unavailable' : formatTokenCount(total)
    const limitText = limit === undefined ? 'unknown' : formatTokenCount(limit)
    const percentage = total === undefined || limit === undefined
        ? '—'
        : `${((total / limit) * 100).toFixed(1)}%`

    return `Context: ${totalText} / ${limitText} tokens (${percentage})`
}

function extractModelId(message: StreamMessage): string | undefined {
    const metadata = message.response_metadata ?? message.kwargs?.response_metadata
    if (!metadata || typeof metadata !== 'object') return undefined

    const rawMetadata = metadata as Record<string, unknown>
    const modelId = rawMetadata.model_name ?? rawMetadata.model
    return typeof modelId === 'string' && modelId ? modelId : undefined
}

function asTokenCount(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? value
        : undefined
}

function validContextWindow(value: number | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function formatTokenCount(value: number): string {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)
}
