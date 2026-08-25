interface ModelMetadata {
    id?: unknown
    context_length?: unknown
}

interface ModelsResponse {
    data?: unknown
}

export interface ModelMetadataOptions {
    apiKey?: string
    baseUrl: string
}

const modelCache = new Map<string, Map<string, number>>()
const inFlightRequests = new Map<string, Promise<Map<string, number>>>()

export async function getModelContextWindow(
    modelId: string,
    options: ModelMetadataOptions,
): Promise<number | undefined> {
    if (!modelId || !options.apiKey) return undefined

    try {
        const models = await loadModels(options)
        const contextWindow = models.get(modelId)
        if (contextWindow === undefined) {
            modelCache.delete(getModelsEndpoint(options.baseUrl))
        }
        return contextWindow
    } catch {
        return undefined
    }
}

async function loadModels(options: ModelMetadataOptions): Promise<Map<string, number>> {
    const endpoint = getModelsEndpoint(options.baseUrl)
    const cached = modelCache.get(endpoint)
    if (cached) return cached

    const inFlight = inFlightRequests.get(endpoint)
    if (inFlight) return inFlight

    const request = requestModels(endpoint, options.apiKey as string)
    inFlightRequests.set(endpoint, request)

    try {
        const models = await request
        modelCache.set(endpoint, models)
        return models
    } finally {
        inFlightRequests.delete(endpoint)
    }
}

function getModelsEndpoint(baseUrl: string): string {
    return `${baseUrl.replace(/\/$/u, '')}/models`
}

async function requestModels(endpoint: string, apiKey: string): Promise<Map<string, number>> {
    const response = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(3_000),
    })

    if (!response.ok) {
        throw new Error(`Failed to load model metadata: HTTP ${response.status}`)
    }

    const body = await response.json() as ModelsResponse
    if (!Array.isArray(body.data)) {
        throw new Error('Failed to load model metadata: invalid response')
    }

    const models = new Map<string, number>()
    for (const rawModel of body.data as ModelMetadata[]) {
        if (!rawModel || typeof rawModel !== 'object') continue
        if (typeof rawModel.id !== 'string') continue
        if (!isContextWindow(rawModel.context_length)) continue

        models.set(rawModel.id, rawModel.context_length)
    }

    return models
}

function isContextWindow(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0
}

export function resetModelMetadataCache(): void {
    modelCache.clear()
    inFlightRequests.clear()
}
