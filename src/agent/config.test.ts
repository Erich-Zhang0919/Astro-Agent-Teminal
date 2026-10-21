import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAstroConfigurationPath, getMCPServerConfig, loadModelConfiguration, loadTavilyApiKey } from './config'

jest.mock('node:os', () => ({ ...jest.requireActual('node:os'), homedir: jest.fn() }))

let home: string
let path: string
const configuration = { model: 'kimi-k2.6', apiKey: 'test-secret', baseURL: 'https://api.moonshot.cn/v1' }

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'astro-model-'))
    jest.mocked(homedir).mockReturnValue(home)
    mkdirSync(join(home, '.astro'))
    path = join(home, '.astro', 'astro.json')
})

afterEach(() => rmSync(home, { recursive: true, force: true }))

it('loads the configuration from the operating system home directory', () => {
    writeFileSync(path, JSON.stringify({ model: configuration, otherSetting: true }))
    expect(loadModelConfiguration()).toEqual(configuration)
    expect(homedir).toHaveBeenCalled()
    expect(getAstroConfigurationPath()).toBe(path)
})

it('loads the search key independently of model configuration and other env entries', () => {
    writeFileSync(path, JSON.stringify({ env: { TAVILY_API_KEY: '  file-secret  ', OTHER_KEY: 'other' } }))
    expect(loadTavilyApiKey()).toBe('file-secret')
})

it('loads model settings independently of search configuration', () => {
    writeFileSync(path, JSON.stringify({ model: configuration, env: { TAVILY_API_KEY: null } }))
    expect(loadModelConfiguration()).toEqual(configuration)
})

it('loads mcpServers independently of other Astro settings without changing its format', () => {
    const mcpServers = {
        local: { command: 'node', args: ['server.js'], env: { TOKEN: '${MCP_TOKEN}' } },
        remote: { transport: 'streamable-http', url: 'https://example.com/mcp' },
    }
    writeFileSync(path, JSON.stringify({ model: configuration, env: {}, hooks: {}, mcpServers }))
    expect(getMCPServerConfig()).toEqual(mcpServers)
})

it('returns no MCP servers for a missing configuration file or section', () => {
    expect(getMCPServerConfig()).toEqual({})
    writeFileSync(path, JSON.stringify({ model: configuration, hooks: {} }))
    expect(getMCPServerConfig()).toEqual({})
})

it.each([null, [], 'test-secret'])('rejects an invalid mcpServers section: %j', mcpServers => {
    writeFileSync(path, JSON.stringify({ model: configuration, mcpServers }))
    expect(getMCPServerConfig).toThrow(`Invalid Astro configuration at mcpServers: ${path}`)
    expect(getMCPServerConfig).not.toThrow('test-secret')
})

it('reports malformed or unreadable MCP configuration without echoing file contents', () => {
    writeFileSync(path, '{"apiKey":"test-secret",')
    expect(getMCPServerConfig).toThrow(`Invalid JSON in Astro configuration: ${path}`)
    expect(getMCPServerConfig).not.toThrow('test-secret')
    rmSync(path)
    mkdirSync(path)
    expect(getMCPServerConfig).toThrow(`Cannot read Astro configuration: ${path}`)
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
    expect(loadTavilyApiKey).toThrow(`Invalid Astro configuration at ${field}: ${path}`)
    expect(loadTavilyApiKey).toThrow('env.TAVILY_API_KEY')
    expect(loadTavilyApiKey).not.toThrow(configuration.apiKey)
})

it('does not fall back to an environment key when file configuration is missing', () => {
    const original = process.env.TAVILY_API_KEY
    process.env.TAVILY_API_KEY = 'environment-secret'
    try {
        expect(loadTavilyApiKey).toThrow(`Astro configuration file not found: ${path}`)
        writeFileSync(path, JSON.stringify({ model: configuration }))
        expect(loadTavilyApiKey).toThrow(`Invalid Astro configuration at env: ${path}`)
        writeFileSync(path, JSON.stringify({ env: { TAVILY_API_KEY: 'file-secret' } }))
        expect(loadTavilyApiKey()).toBe('file-secret')
        expect(process.env.TAVILY_API_KEY).toBe('environment-secret')
    } finally {
        if (original === undefined) delete process.env.TAVILY_API_KEY
        else process.env.TAVILY_API_KEY = original
    }
})

it('tells the user to create the missing configuration file', () => {
    expect(loadModelConfiguration).toThrow(`Astro configuration file not found: ${path}`)
    expect(loadModelConfiguration).toThrow('Set model.model and model.apiKey')
})

it('reports unreadable configuration', () => {
    mkdirSync(path)
    expect(loadModelConfiguration).toThrow(`Cannot read Astro configuration: ${path}`)
})

it('reports invalid JSON without including its contents', () => {
    writeFileSync(path, '{"apiKey":"test-secret",')
    expect(loadModelConfiguration).toThrow(`Invalid JSON in Astro configuration: ${path}`)
    expect(loadModelConfiguration).not.toThrow('test-secret')
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
    expect(loadModelConfiguration).toThrow(`Invalid Astro configuration at ${field}`)
    expect(loadModelConfiguration).toThrow(path)
    expect(loadModelConfiguration).not.toThrow('test-secret')
})

