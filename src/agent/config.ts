import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

export const WORKSPACE_DIR = join(homedir(), '.astro')
export const CONFIG_PATH = join(WORKSPACE_DIR, 'astro.json')

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

export class AstroConfigurationError extends Error {
    constructor(message: string, readonly userMessage: string) {
        super(message)
        this.name = 'AstroConfigurationError'
    }
}

const configurationFields: Record<string, string> = {
    'model.model': '模型名称：请填写非空的模型名称',
    'model.apiKey': '模型 API Key：请填写模型服务商提供的密钥',
    'model.baseURL': '模型接口地址：请填写以 http:// 或 https:// 开头的有效 URL',
    'env.TAVILY_API_KEY': '搜索 API Key：请填写 Tavily 提供的密钥',
    mcpServers: 'MCP 服务配置：请填写以服务名称为键的 JSON 对象',
}

function configurationHelp(path: string, title: string, details: string[]): string {
    return [
        `⚙️  ${title}`,
        `📝 请编辑配置文件：${path}`,
        '',
        ...details,
        '',
        '📖 配置参考：https://xxxx/#config',
        '💬 保存配置后，请重新运行 astro chat（或原命令）。',
    ].join('\n')
}

export function getAstroConfigurationPath(): string {
    return CONFIG_PATH
}

function loadConfiguration<T>(schema: z.ZodType<T>, guidance: string, missingValue?: T): T {
    const path = getAstroConfigurationPath()
    let source: string
    try {
        source = readFileSync(path, 'utf8')
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            if (missingValue !== undefined) return missingValue
            throw new AstroConfigurationError(
                `Astro configuration file not found: ${path}. ${guidance}`,
                configurationHelp(path, '还没有找到 Astro 配置文件。', ['请创建该文件，并填写模型和搜索配置。']),
            )
        }
        throw new AstroConfigurationError(
            `Cannot read Astro configuration: ${path}. Check the file and its permissions.`,
            configurationHelp(path, '无法读取 Astro 配置文件。', ['请确认该路径是文件，且当前用户有读取权限。']),
        )
    }

    let input: unknown
    try { input = JSON.parse(source) } catch {
        throw new AstroConfigurationError(
            `Invalid JSON in Astro configuration: ${path}. Provide a valid JSON object.`,
            configurationHelp(path, 'Astro 配置文件的 JSON 格式有误。', ['请检查双引号、逗号和括号，保存为有效的 JSON 对象。']),
        )
    }
    const parsed = schema.safeParse(input)
    if (!parsed.success) {
        const locations = parsed.error.issues.map(issue => issue.path.join('.') || 'configuration')
        const fields = new Set(locations.flatMap(location => {
            if (location === 'configuration') {
                return Object.keys(schema instanceof z.ZodObject ? schema.shape : {})
                    .flatMap(section => Object.keys(configurationFields)
                        .filter(field => field === section || field.startsWith(`${section}.`)))
            }
            const knownFields = Object.keys(configurationFields)
                .filter(field => field === location || field.startsWith(`${location}.`))
            return knownFields.length ? knownFields : ['mcpServers']
        }))
        throw new AstroConfigurationError(
            `Invalid Astro configuration at ${locations.join(', ')}: ${path}. ${guidance}`,
            configurationHelp(path, 'Astro 还有配置未完成，或填写的格式不正确：',
                [...fields].map(field => `  • ${field}（${configurationFields[field]}）`)),
        )
    }
    return parsed.data
}

/** Check all required settings before command imports initialize models or tools. */
export function validateStartupConfiguration(): void {
    loadConfiguration(modelConfigurationSchema.extend(tavilyConfigurationSchema.shape),
        'Set model.model, model.apiKey, model.baseURL and env.TAVILY_API_KEY.')
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
