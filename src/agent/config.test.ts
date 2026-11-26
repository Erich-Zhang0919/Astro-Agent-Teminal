import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
let config: typeof import('./config')

jest.mock('node:os', () => ({ ...jest.requireActual('node:os'), homedir: jest.fn() }))

let home: string
let path: string
const configuration = { model: 'kimi-k2.6', apiKey: 'test-secret', baseURL: 'https://api.moonshot.cn/v1' }

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'astro-model-'))
    jest.isolateModules(() => {
        require('node:os').homedir.mockReturnValue(home)
        config = require('./config')
    })
    mkdirSync(join(home, '.astro'))
    path = join(home, '.astro', 'astro.json')
})

afterEach(() => rmSync(home, { recursive: true, force: true }))

it('loads the configuration from the operating system home directory', () => {
    writeFileSync(path, JSON.stringify({ model: configuration, otherSetting: true }))
    expect(config.loadModelConfiguration()).toEqual(configuration)
    expect(config.WORKSPACE_DIR).toBe(join(home, '.astro'))
    expect(config.CONFIG_PATH).toBe(path)
    expect(config.getAstroConfigurationPath()).toBe(path)
})

it('loads the search key independently of model configuration and other env entries', () => {
    writeFileSync(path, JSON.stringify({ env: { TAVILY_API_KEY: '  file-secret  ', OTHER_KEY: 'other' } }))
    expect(config.loadTavilyApiKey()).toBe('file-secret')
})

it('loads model settings independently of search configuration', () => {
    writeFileSync(path, JSON.stringify({ model: configuration, env: { TAVILY_API_KEY: null } }))
    expect(config.loadModelConfiguration()).toEqual(configuration)
})

function startupMessage(input: unknown): string {
    writeFileSync(path, JSON.stringify(input))
    try {
        config.validateStartupConfiguration()
    } catch (error) {
        expect(error).toBeInstanceOf(config.AstroConfigurationError)
        return (error as InstanceType<typeof config.AstroConfigurationError>).userMessage
    }
    throw new Error('Expected startup configuration to be rejected')
}

it('lists both empty keys from the installer template with actionable Chinese guidance', () => {
    const message = startupMessage({ model: { ...configuration, apiKey: '' }, env: { TAVILY_API_KEY: '' } })
    expect(message).toContain('model.apiKey（模型 API Key：')
    expect(message).toContain('env.TAVILY_API_KEY（搜索 API Key：')
    expect(message).not.toContain('• model.model')
    expect(message).not.toContain('• model.baseURL')
    expect(message).toContain(path)
    expect(message).toContain('https://astro-aiagent.vercel.app/docs/')
    expect(message).toContain('保存配置后，请重新运行 astro chat（或原命令）')
})

it.each([{}, null, [], { model: null, env: null }])('expands missing or invalid sections into all required fields: %j', input => {
    const message = startupMessage(input)
    for (const field of ['model.model', 'model.apiKey', 'model.baseURL', 'env.TAVILY_API_KEY']) {
        expect(message).toContain(`• ${field}`)
    }
})

it('only reports invalid fields and never echoes configured values', () => {
    const message = startupMessage({
        model: { ...configuration, baseURL: 'ftp://private-host/secret-path' },
        env: { TAVILY_API_KEY: 'search-secret' },
    })
    expect(message).toContain('• model.baseURL')
    expect(message).toContain('http:// 或 https://')
    for (const value of ['private-host', 'secret-path', 'test-secret', 'search-secret', '• model.apiKey', '• env.TAVILY_API_KEY']) {
        expect(message).not.toContain(value)
    }
})

it('allows startup when all required fields are configured', () => {
    writeFileSync(path, JSON.stringify({ model: configuration, env: { TAVILY_API_KEY: 'search-secret' } }))
    expect(config.validateStartupConfiguration).not.toThrow()
})

it('provides safe Chinese guidance for missing files, invalid JSON and unreadable files', () => {
    const userMessage = () => {
        try { config.validateStartupConfiguration() } catch (error) {
            expect(error).toBeInstanceOf(config.AstroConfigurationError)
            const message = (error as InstanceType<typeof config.AstroConfigurationError>).userMessage
            expect(message).toContain(path)
            expect(message).not.toContain('test-secret')
            return message
        }
        throw new Error('Expected startup configuration to be rejected')
    }
    expect(userMessage()).toContain('还没有找到 Astro 配置文件')
    writeFileSync(path, '{"apiKey":"test-secret",')
    expect(userMessage()).toContain('JSON 格式有误')
    rmSync(path)
    mkdirSync(path)
    expect(userMessage()).toContain('读取权限')
})

it('loads mcpServers independently of other Astro settings without changing its format', () => {
    const mcpServers = {
        local: { command: 'node', args: ['server.js'], env: { TOKEN: '${MCP_TOKEN}' } },
        remote: { transport: 'streamable-http', url: 'https://example.com/mcp' },
    }
    writeFileSync(path, JSON.stringify({ model: configuration, env: {}, hooks: {}, mcpServers }))
    expect(config.getMCPServerConfig()).toEqual(mcpServers)
})

it('returns no MCP servers for a missing configuration file or section', () => {
    expect(config.getMCPServerConfig()).toEqual({})
    writeFileSync(path, JSON.stringify({ model: configuration, hooks: {} }))
    expect(config.getMCPServerConfig()).toEqual({})
})

it.each([null, [], 'test-secret'])('rejects an invalid mcpServers section: %j', mcpServers => {
    writeFileSync(path, JSON.stringify({ model: configuration, mcpServers }))
    expect(config.getMCPServerConfig).toThrow(`Invalid Astro configuration at mcpServers: ${path}`)
    expect(config.getMCPServerConfig).not.toThrow('test-secret')
})

it('reports malformed or unreadable MCP configuration without echoing file contents', () => {
    writeFileSync(path, '{"apiKey":"test-secret",')
    expect(config.getMCPServerConfig).toThrow(`Invalid JSON in Astro configuration: ${path}`)
    expect(config.getMCPServerConfig).not.toThrow('test-secret')
    rmSync(path)
    mkdirSync(path)
    expect(config.getMCPServerConfig).toThrow(`Cannot read Astro configuration: ${path}`)
})

it.each([
    ['missing env section', {}, 'env'],
    ['null env section', { env: null }, 'env'],
    ['missing key', { env: {} }, 'env.TAVILY_API_KEY'],
    ['empty key', { env: { TAVILY_API_KEY: '' } }, 'env.TAVILY_API_KEY'],
    ['blank key', { env: { TAVILY_API_KEY: '  ' } }, 'env.TAVILY_API_KEY'],
    ['invalid key type', { env: { TAVILY_API_KEY: 123 } }, 'env.TAVILY_API_KEY'],
])('rejects %s with a configuration path and field', (_name, input, field) => {
    writeFileSync(path, JSON.stringify({ ...input, model: configuration }))
    expect(config.loadTavilyApiKey).toThrow(`Invalid Astro configuration at ${field}: ${path}`)
    expect(config.loadTavilyApiKey).toThrow('env.TAVILY_API_KEY')
    expect(config.loadTavilyApiKey).not.toThrow(configuration.apiKey)
})

it('does not fall back to an environment key when file configuration is missing', () => {
    const original = process.env.TAVILY_API_KEY
    process.env.TAVILY_API_KEY = 'environment-secret'
    try {
        expect(config.loadTavilyApiKey).toThrow(`Astro configuration file not found: ${path}`)
        writeFileSync(path, JSON.stringify({ model: configuration }))
        expect(config.loadTavilyApiKey).toThrow(`Invalid Astro configuration at env: ${path}`)
        writeFileSync(path, JSON.stringify({ env: { TAVILY_API_KEY: 'file-secret' } }))
        expect(config.loadTavilyApiKey()).toBe('file-secret')
        expect(process.env.TAVILY_API_KEY).toBe('environment-secret')
    } finally {
        if (original === undefined) delete process.env.TAVILY_API_KEY
        else process.env.TAVILY_API_KEY = original
    }
})

it('tells the user to create the missing configuration file', () => {
    expect(config.loadModelConfiguration).toThrow(`Astro configuration file not found: ${path}`)
    expect(config.loadModelConfiguration).toThrow('Set model.model and model.apiKey')
})

it('reports unreadable configuration', () => {
    mkdirSync(path)
    expect(config.loadModelConfiguration).toThrow(`Cannot read Astro configuration: ${path}`)
})

it('reports invalid JSON without including its contents', () => {
    writeFileSync(path, '{"apiKey":"test-secret",')
    expect(config.loadModelConfiguration).toThrow(`Invalid JSON in Astro configuration: ${path}`)
    expect(config.loadModelConfiguration).not.toThrow('test-secret')
})

it.each([
    ['missing model section', {}, 'model'],
    ['null configuration', null, 'configuration'],
    ['null model section', { model: null }, 'model'],
    ['empty model section', { model: {} }, 'model.model'],
    ['missing model name', { model: { ...configuration, model: undefined } }, 'model.model'],
    ['blank model name', { model: { ...configuration, model: '  ' } }, 'model.model'],
    ['missing API key', { model: { ...configuration, apiKey: undefined } }, 'model.apiKey'],
    ['blank API key', { model: { ...configuration, apiKey: '  ' } }, 'model.apiKey'],
    ['invalid API key type', { model: { ...configuration, apiKey: 123 } }, 'model.apiKey'],
    ['missing base URL', { model: { ...configuration, baseURL: undefined } }, 'model.baseURL'],
    ['invalid base URL', { model: { ...configuration, baseURL: 'not-a-url' } }, 'model.baseURL'],
    ['unsupported URL protocol', { model: { ...configuration, baseURL: 'ftp://example.com' } }, 'model.baseURL'],
])('rejects %s and identifies the field and configuration path', (_name, input, field) => {
    writeFileSync(path, JSON.stringify(input))
    expect(config.loadModelConfiguration).toThrow(`Invalid Astro configuration at ${field}`)
    expect(config.loadModelConfiguration).toThrow(path)
    expect(config.loadModelConfiguration).not.toThrow('test-secret')
})

