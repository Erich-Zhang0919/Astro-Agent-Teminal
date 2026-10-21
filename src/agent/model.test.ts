import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatOpenAI } from '@langchain/openai'
import { createModels, loadModelConfiguration } from './model'

jest.mock('node:os', () => ({ ...jest.requireActual('node:os'), homedir: jest.fn() }))
jest.mock('@langchain/openai', () => ({ ChatOpenAI: jest.fn() }))

let home: string
let path: string
beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'astro-model-'))
    jest.mocked(homedir).mockReturnValue(home)
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
    expect(ChatOpenAI).toHaveBeenNthCalledWith(1, { ...shared, streaming: true, streamUsage: true })
    expect(ChatOpenAI).toHaveBeenNthCalledWith(2, { ...shared, streaming: false })
})
