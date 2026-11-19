import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const mockChatOpenAI = jest.fn()
let createModels: typeof import('./model')['createModels']

jest.mock('node:os', () => ({ ...jest.requireActual('node:os'), homedir: jest.fn() }))
jest.mock('@langchain/openai', () => ({ ChatOpenAI: mockChatOpenAI }))

let home: string
let path: string
beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'astro-model-'))
    jest.isolateModules(() => {
        require('node:os').homedir.mockReturnValue(home)
        createModels = require('./model').createModels
    })
    mkdirSync(join(home, '.astro'))
    path = join(home, '.astro', 'astro.json')
})

afterEach(() => rmSync(home, { recursive: true, force: true }))

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
    expect(mockChatOpenAI).toHaveBeenNthCalledWith(1, { ...shared, streaming: true, streamUsage: true })
    expect(mockChatOpenAI).toHaveBeenNthCalledWith(2, { ...shared, streaming: false })
})
