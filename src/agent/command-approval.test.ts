import { runAgentStream } from './agent'
import { buildProgram } from './command'
import * as readline from 'readline'

jest.mock('./agent', () => ({
    runAgentStream: jest.fn(),
    compactAgentContext: jest.fn(),
}))
jest.mock('./session-store', () => ({ sessionStore: {} }))
jest.mock('readline', () => ({
    ...jest.requireActual('readline'),
    createInterface: jest.fn(),
}))

afterEach(() => jest.restoreAllMocks())

it('wires astro ask to the default-deny confirmation prompt without a terminal', async () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const run = runAgentStream as jest.MockedFunction<typeof runAgentStream>
    run.mockImplementation(async (_message, _onToken, _threadId, _signal, options) => {
        expect(await options?.confirmTool?.({
            name: 'read_file', args: { file_path: 'a.txt' },
            index: 1, total: 1,
        })).toBe(false)
        return { text: '', modelId: 'test' }
    })

    await buildProgram().parseAsync(['ask', 'hello'], { from: 'user' })

    expect(run).toHaveBeenCalledTimes(1)
    expect(write.mock.calls.map(([text]) => String(text)).join(''))
        .toContain('[Denied: no interactive terminal]')
})

it('wires astro chat to confirmation for every proposed tool call', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    const lines = ['hello', 'exit']
    jest.mocked(readline.createInterface).mockReturnValue({
        question: (_prompt: string, callback: (answer: string) => void) =>
            callback(lines.shift() ?? 'exit'),
        pause: jest.fn(), resume: jest.fn(), close: jest.fn(),
    } as unknown as readline.Interface)
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const run = runAgentStream as jest.MockedFunction<typeof runAgentStream>
    run.mockImplementation(async (_message, _onToken, _threadId, _signal, options) => {
        const approve = options?.confirmTool
        expect(approve).toBeDefined()
        expect(await approve?.({ name: 'read_file', args: { file_path: 'a.txt' },
            index: 1, total: 2 })).toBe(false)
        expect(await approve?.({ name: 'write_file', args: { file_path: 'b.txt' },
            index: 2, total: 2 })).toBe(false)
        return { text: 'done', modelId: 'test' }
    })

    await buildProgram().parseAsync(['chat'], { from: 'user' })

    expect(run).toHaveBeenCalledTimes(1)
    expect(write.mock.calls.map(([text]) => String(text)).join(''))
        .toContain('Tool 2/2: write_file')
})
