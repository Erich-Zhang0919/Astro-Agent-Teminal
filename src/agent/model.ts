import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ChatOpenAI } from '@langchain/openai'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { z } from 'zod'

const configurationSchema = z.object({
    model: z.object({
        model: z.string().trim().min(1),
        apiKey: z.string().trim().min(1),
        baseURL: z.url({ protocol: /^https?$/ }),
    }),
})

export type ModelConfiguration = z.infer<typeof configurationSchema>['model']

export function loadModelConfiguration(): ModelConfiguration {
    const path = join(homedir(), '.astro', 'astro.json')
    let source: string
    try {
        source = readFileSync(path, 'utf8')
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error(`Model configuration file not found: ${path}. Create it with model.model, model.apiKey and model.baseURL.`)
        }
        throw new Error(`Cannot read model configuration: ${path}. Check the file and its permissions.`)
    }

    let input: unknown
    try { input = JSON.parse(source) } catch {
        throw new Error(`Invalid JSON in model configuration: ${path}. Provide a valid JSON object.`)
    }
    const parsed = configurationSchema.safeParse(input)
    if (!parsed.success) {
        const locations = parsed.error.issues.map(issue => issue.path.join('.') || 'model').join(', ')
        throw new Error(`Invalid model configuration at ${locations}: ${path}. Set model.model and model.apiKey to non-empty strings and model.baseURL to an HTTP(S) URL.`)
    }
    return parsed.data.model
}

export function createModels(config: ModelConfiguration = loadModelConfiguration()) {
    const sharedModelOptions = {
        model: config.model,
        apiKey: config.apiKey,
        configuration: { baseURL: config.baseURL },
        modelKwargs: { thinking: { type: 'disabled' } },  // 关闭 thinking
    }

    // Normalize the integrations' parallel CJS/ESM declaration trees at this boundary.
    const model = new ChatOpenAI({
        ...sharedModelOptions,
        streaming: true,
        streamUsage: true,
    }) as unknown as BaseChatModel

    const compactionModel = new ChatOpenAI({
        ...sharedModelOptions,
        streaming: false,
    }) as unknown as BaseChatModel

    return { config, model, compactionModel }
}
