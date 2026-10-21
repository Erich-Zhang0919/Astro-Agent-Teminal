import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

const modelConfigurationSchema = z.object({
    model: z.object({
        model: z.string().trim().min(1),
        apiKey: z.string().trim().min(1),
        baseURL: z.url({ protocol: /^https?$/ }),
    }),
})

const tavilyConfigurationSchema = z.object({
    env: z.object({ TAVILY_API_KEY: z.string().trim().min(1) }),
})

const mcpConfigurationSchema = z.object({
    mcpServers: z.record(z.string().min(1), z.unknown()).default({}),
})

export type ModelConfiguration = z.infer<typeof modelConfigurationSchema>['model']

export function getAstroConfigurationPath(): string {
    return join(homedir(), '.astro', 'astro.json')
}

function loadConfiguration<T>(schema: z.ZodType<T>, guidance: string, missingValue?: T): T {
    const path = getAstroConfigurationPath()
    let source: string
    try {
        source = readFileSync(path, 'utf8')
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            if (missingValue !== undefined) return missingValue
            throw new Error(`Astro configuration file not found: ${path}. ${guidance}`)
        }
        throw new Error(`Cannot read Astro configuration: ${path}. Check the file and its permissions.`)
    }

    let input: unknown
    try { input = JSON.parse(source) } catch {
        throw new Error(`Invalid JSON in Astro configuration: ${path}. Provide a valid JSON object.`)
    }
    const parsed = schema.safeParse(input)
    if (!parsed.success) {
        const locations = parsed.error.issues.map(issue => issue.path.join('.') || 'configuration').join(', ')
        throw new Error(`Invalid Astro configuration at ${locations}: ${path}. ${guidance}`)
    }
    return parsed.data
}

export function loadModelConfiguration(): ModelConfiguration {
    return loadConfiguration(modelConfigurationSchema,
        'Set model.model and model.apiKey to non-empty strings and model.baseURL to an HTTP(S) URL.').model
}

export function loadTavilyApiKey(): string {
    return loadConfiguration(tavilyConfigurationSchema,
        'Set env.TAVILY_API_KEY to a non-empty string.').env.TAVILY_API_KEY
}

export function getMCPServerConfig(): Record<string, unknown> {
    return loadConfiguration(mcpConfigurationSchema,
        'Set mcpServers to an object keyed by server name.', { mcpServers: {} }).mcpServers
}
