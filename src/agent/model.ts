import { ChatOpenAI } from '@langchain/openai'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { loadModelConfiguration, type ModelConfiguration } from './config'

export { loadModelConfiguration, type ModelConfiguration } from './config'

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
