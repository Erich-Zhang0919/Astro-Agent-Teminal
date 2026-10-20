import { getModelContextWindow, resetModelMetadataCache } from './model-metadata'
import { formatContextUsage, shouldAutoCompact, shouldWarnContextUsage } from './context-usage'

const options = { apiKey: 'test-key', baseUrl: 'https://api.deepseek.com/v1' }
let fetchMock: jest.SpyInstance

function respond(body: unknown, ok = true): void {
    fetchMock.mockResolvedValue({ ok, status: ok ? 200 : 503, json: async () => body })
}

beforeEach(() => {
    resetModelMetadataCache()
    fetchMock = jest.spyOn(globalThis, 'fetch')
})

afterEach(() => jest.restoreAllMocks())

it('uses live context_length for any provider and caches the model list', async () => {
    const custom = { ...options, baseUrl: 'https://custom.example/v1/' }
    respond({ data: [{ id: 'custom-model', context_length: 123_456 }] })
    expect(await getModelContextWindow('custom-model', custom)).toBe(123_456)
    expect(await getModelContextWindow('custom-model', custom)).toBe(123_456)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('https://custom.example/v1/models', {
        headers: { Authorization: 'Bearer test-key' },
        signal: expect.any(AbortSignal),
    })
})

it('reads DeepSeek context_window and prefers it over the documented fallback', async () => {
    respond({ data: [{ id: 'deepseek-flash', context_window: 524_288, max_output_tokens: 100 }] })
    expect(await getModelContextWindow('deepseek-flash', options)).toBe(524_288)
})

it('keeps valid context_length precedence when both metadata fields are present', async () => {
    respond({ data: [{ id: 'deepseek-flash', context_length: 128_000, context_window: 256_000 }] })
    expect(await getModelContextWindow('deepseek-flash', options)).toBe(128_000)
})

it.each([0, -1, 1.5, '128000', null])('ignores invalid context_length %p and reads context_window', async (value) => {
    respond({ data: [{ id: 'deepseek-flash', context_length: value, context_window: 256_000 }] })
    expect(await getModelContextWindow('deepseek-flash', options)).toBe(256_000)
})

it.each<[string, string, number]>([
    ['https://api.deepseek.com', 'deepseek-flash', 1_048_576],
    ['https://api.minimax.cn/v1', 'MiniMax-M3.1-Flash', 1_000_000],
    ['https://api.minimaxi.com/v1', 'MiniMax-M2.7', 204_800],
    ['https://api.minimaxi.com/v1', 'MiniMax-M2.5', 196_608],
    ['https://api.minimax.io/v1', 'MiniMax-M3', 1_000_000],
    ['https://open.bigmodel.cn/api/paas/v4', 'glm-5.3', 1_000_000],
    ['https://open.bigmodel.cn/api/coding/paas/v4', 'glm-4.7', 200_000],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.8-max', 1_000_000],
    ['https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'qwen3.7-plus-2026-05-26', 1_000_000],
    ['https://api.xiaomimimo.com/v1', 'mimo-v2.6-pro', 1_000_000],
])('falls back for %s / %s when the API omits the window', async (baseUrl, modelId, limit) => {
    respond({ data: [{ id: modelId, max_output_tokens: 128 }] })
    expect(await getModelContextWindow(modelId, { ...options, baseUrl })).toBe(limit)
})

it.each(['HTTP error', 'invalid body', 'network error', 'timeout', 'invalid JSON'])('falls back on %s', async (failure) => {
    if (failure === 'HTTP error') respond({}, false)
    else if (failure === 'invalid body') respond({ data: null })
    else if (failure === 'invalid JSON') fetchMock.mockResolvedValue({ ok: true, json: async () => { throw new SyntaxError() } })
    else fetchMock.mockRejectedValue(new Error(failure))
    expect(await getModelContextWindow('deepseek-flash', options)).toBe(1_048_576)
})

it.each([
    ['https://proxy.example/v1', 'deepseek-flash'],
    ['https://api.deepseek.com.evil.example/v1', 'deepseek-flash'],
    ['https://api.deepseek.com/v1', 'deepseek-future'],
    ['https://api.deepseek.com/v1', 'deepseek-flash-custom'],
    ['https://api.deepseek.com/v1', 'toString'],
    ['https://toString/v1', 'deepseek-flash'],
    ['invalid-url', 'deepseek-flash'],
])('leaves unknown providers and model variants unknown: %s / %s', async (baseUrl, modelId) => {
    respond({ data: [] })
    expect(await getModelContextWindow(modelId, { ...options, baseUrl })).toBeUndefined()
})

it('does not substitute an output limit for a context window', async () => {
    respond({ data: [{ id: 'custom-model', max_output_tokens: 65_536 }] })
    expect(await getModelContextWindow('custom-model', options)).toBeUndefined()
})

it('does not query models without credentials or a model ID', async () => {
    expect(await getModelContextWindow('deepseek-flash', { ...options, apiKey: undefined })).toBeUndefined()
    expect(await getModelContextWindow('', options)).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
})

it('uses the fallback in displayed context usage and warning/compaction decisions', async () => {
    respond({ data: [] })
    const result = {
        text: '', modelId: 'glm-4.7',
        contextWindow: await getModelContextWindow('glm-4.7', { ...options, baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }),
        usage: { inputTokens: 170_000, outputTokens: 10_000, totalTokens: 180_000 },
    }
    expect(formatContextUsage(result)).toBe('Context: 180,000 / 200,000 tokens (90.0%)')
    expect(shouldWarnContextUsage(result)).toBe(true)
    expect(shouldAutoCompact(result)).toBe(true)
})
