import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatOpenAI } from '@langchain/openai'
import { createModels, loadModelConfiguration } from './model'

jest.mock('node:os', () => ({ ...jest.requireActual('node:os'), homedir: jest.fn() }))
jest.mock('@langchain/openai', () => ({ ChatOpenAI: jest.fn() }))

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
})

it('tells the user to create the missing configuration file', () => {
    expect(loadModelConfiguration).toThrow(`Model configuration file not found: ${path}`)
    expect(loadModelConfiguration).toThrow('model.model, model.apiKey and model.baseURL')
})

it('reports unreadable configuration', () => {
    mkdirSync(path)
    expect(loadModelConfiguration).toThrow(`Cannot read model configuration: ${path}`)
})

it('reports invalid JSON without including its contents', () => {
    writeFileSync(path, '{"apiKey":"test-secret",')
    expect(loadModelConfiguration).toThrow(`Invalid JSON in model configuration: ${path}`)
    expect(loadModelConfiguration).not.toThrow('test-secret')
})

it.each([
    ['missing model section', {}, 'model'],
    ['null configuration', null, 'model'],
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
    expect(loadModelConfiguration).toThrow(`Invalid model configuration at ${field}`)
    expect(loadModelConfiguration).toThrow(path)
    expect(loadModelConfiguration).not.toThrow('test-secret')
})

it('uses the configured credentials and endpoint for both chat and compaction', () => {
    const custom = { model: 'custom-model', apiKey: 'custom-key', baseURL: 'https://example.com/v1' }
    writeFileSync(path, JSON.stringify({ model: custom }))
    const models = createModels()
    const shared = {
        model: custom.model,
        apiKey: custom.apiKey,
        configuration: { baseURL: custom.baseURL },
        modelKwargs: { thinking: { type: 'disabled' } },
    }
    expect(models.config).toEqual(custom)
    expect(ChatOpenAI).toHaveBeenNthCalledWith(1, { ...shared, streaming: true, streamUsage: true })
    expect(ChatOpenAI).toHaveBeenNthCalledWith(2, { ...shared, streaming: false })
})
