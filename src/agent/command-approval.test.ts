import { endAgentSession, runAgentStream, startAgentSession } from './agent'
import { buildProgram } from './command'
import * as readline from 'readline'

jest.mock('./agent', () => ({
    runAgentStream: jest.fn(),
    compactAgentContext: jest.fn(),
    startAgentSession: jest.fn(),
    endAgentSession: jest.fn(),
}))
jest.mock('./session-store', () => ({ sessionStore: { hasSession: jest.fn(async () => true) } }))
jest.mock('readline', () => ({
    ...jest.requireActual('readline'),
    createInterface: jest.fn(),
}))

afterEach(() => jest.restoreAllMocks())
beforeEach(() => {
    jest.mocked(startAgentSession).mockResolvedValue(undefined)
    jest.mocked(endAgentSession).mockResolvedValue(undefined)
})

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
        once: jest.fn(), off: jest.fn(),
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

it('passes the explicit hooks path and ask lifecycle reasons', async () => {
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    jest.mocked(runAgentStream).mockResolvedValue({ text: 'done', modelId: 'test' })
    await buildProgram().parseAsync(['ask', 'hello', '--thread', 'thread', '--hooks', 'custom.json'],
        { from: 'user' })
    expect(startAgentSession).toHaveBeenCalledWith('thread', expect.objectContaining({
        reason: 'ask', hooksPath: 'custom.json', onHookDiagnostic: expect.any(Function),
    }))
    expect(jest.mocked(runAgentStream).mock.calls[0][4]?.hooksPath).toBe('custom.json')
    expect(endAgentSession).toHaveBeenCalledWith('thread', 'ask_completed')
})

it('passes MCP configuration and diagnostics to both activation and ask execution', async () => {
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    jest.mocked(runAgentStream).mockResolvedValue({ text: 'done', modelId: 'test' })
    await buildProgram().parseAsync(['ask', 'hello', '--thread', 'mcp-thread', '--mcp-config', 'custom-mcp.json'], { from: 'user' })
    expect(startAgentSession).toHaveBeenCalledWith('mcp-thread', expect.objectContaining({
        mcpConfigPath: 'custom-mcp.json', onMcpDiagnostic: expect.any(Function),
    }))
    expect(jest.mocked(runAgentStream).mock.calls[0][4]?.mcpConfigPath).toBe('custom-mcp.json')
})

it('does not run the agent or end an activation when SessionStart blocks ask', async () => {
    jest.mocked(startAgentSession).mockRejectedValueOnce(new Error('start denied'))
    await expect(buildProgram().parseAsync(['ask', 'hello'], { from: 'user' })).rejects.toThrow('start denied')
    expect(runAgentStream).not.toHaveBeenCalled()
    expect(endAgentSession).not.toHaveBeenCalled()
})

it('ends ask with an error reason if the agent fails', async () => {
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    jest.mocked(runAgentStream).mockRejectedValueOnce(new Error('agent failed'))
    await expect(buildProgram().parseAsync(['ask', 'hello', '--thread', 'thread'],
        { from: 'user' })).rejects.toThrow('agent failed')
    expect(endAgentSession).toHaveBeenCalledWith('thread', 'error')
})

function mockChatInput(lines: string[]) {
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    jest.mocked(readline.createInterface).mockReturnValue({
        question: (_prompt: string, callback: (answer: string) => void) => callback(lines.shift() ?? 'exit'),
        pause: jest.fn(), resume: jest.fn(), close: jest.fn(), once: jest.fn(), off: jest.fn(),
    } as unknown as readline.Interface)
    jest.mocked(runAgentStream).mockResolvedValue({ text: 'done', modelId: 'test' })
}

it('starts the destination before ending the previous chat session on new and rewind', async () => {
    mockChatInput(['/new', '/rewind restored', 'hello', 'exit'])
    const events: string[] = []
    jest.mocked(startAgentSession).mockImplementation(async (id, options) => {
        events.push(`start:${id}:${options?.reason}`)
    })
    jest.mocked(endAgentSession).mockImplementation(async (id, reason) => {
        events.push(`end:${id}:${reason}`)
    })
    await buildProgram().parseAsync(['chat', '--hooks', 'custom.json'], { from: 'user' })
    const initialId = jest.mocked(startAgentSession).mock.calls[0][0]
    const newId = jest.mocked(startAgentSession).mock.calls[1][0]
    expect(events).toEqual([
        `start:${initialId}:startup`, `start:${newId}:new`, `end:${initialId}:switch`,
        'start:restored:resume', `end:${newId}:switch`, 'end:restored:exit',
    ])
    expect(jest.mocked(runAgentStream).mock.calls[0][2]).toBe('restored')
    expect(jest.mocked(startAgentSession).mock.calls.every(([, options]) =>
        options?.hooksPath === 'custom.json')).toBe(true)
})

it('keeps the original chat session when the destination start is blocked', async () => {
    mockChatInput(['/new', 'hello', 'exit'])
    jest.mocked(startAgentSession).mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('new session denied'))
    await buildProgram().parseAsync(['chat'], { from: 'user' })
    const initialId = jest.mocked(startAgentSession).mock.calls[0][0]
    expect(jest.mocked(runAgentStream).mock.calls[0][2]).toBe(initialId)
    expect(endAgentSession).toHaveBeenCalledTimes(1)
    expect(endAgentSession).toHaveBeenCalledWith(initialId, 'exit')
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('new session denied'))
})

it.each(['ask', 'chat'])('shows compact tools and hooks in %s without results or an approval prompt', async (mode) => {
    mockChatInput(['list dist', 'exit'])
    const write = jest.mocked(process.stdout.write)
    jest.mocked(runAgentStream).mockImplementation(async (_message, onToken, _thread, _signal, options) => {
        expect(options?.onToolEvent).toBeDefined()
        const info = { name: 'exec', toolCallId: 'call', args: { command: 'ls -la dist' } }
        onToken('Checking the directory.')
        await options?.onHookEvent?.({ event: 'PreToolUse', eventId: 'pre', stdout: 'Checking tool: exec\n', stderr: '' })
        await options?.onToolEvent?.({ ...info, type: 'start' })
        await options?.onToolEvent?.({ ...info, type: 'result', status: 'success', content: 'agent\nindex.js' })
        await options?.onHookEvent?.({ event: 'PostToolUse', eventId: 'post', stdout: 'Tool completed: exec\n', stderr: '' })
        onToken('There are two entries.')
        return { text: 'Checking the directory.There are two entries.', modelId: 'test' }
    })
    await buildProgram().parseAsync(mode === 'ask' ? ['ask', 'list dist'] : ['chat'], { from: 'user' })
    const output = write.mock.calls.map(([text]) => String(text)).join('')
    expect(output).toContain('[Tool] exec called: {"command":"ls -la dist"}')
    expect(output).toContain('[Hook PreToolUse] Checking tool: exec')
    expect(output).toContain('[Hook PostToolUse] Tool completed: exec')
    expect(output).not.toContain('agent\nindex.js')
    expect(output).not.toContain('Result:')
    expect(output).toContain('Astro: Checking the directory.\n')
    expect(output).toContain('Astro: There are two entries.')
    expect(output).not.toContain('Approve this tool call?')
})

it('wires session hook display before startup and through shutdown', async () => {
    mockChatInput(['hello', 'exit'])
    let notify: Parameters<typeof startAgentSession>[1]
    jest.mocked(startAgentSession).mockImplementation(async (_id, options) => {
        notify = options
        await options?.onHookEvent?.({ event: 'SessionStart', eventId: 'start', stdout: 'Session started\n', stderr: '' })
    })
    jest.mocked(endAgentSession).mockImplementation(async () => {
        await notify?.onHookEvent?.({ event: 'SessionEnd', eventId: 'end', stdout: 'Session ended\n', stderr: '' })
    })
    jest.mocked(runAgentStream).mockImplementation(async (_message, onToken) => {
        onToken('done')
        return { text: 'done', modelId: 'test' }
    })
    await buildProgram().parseAsync(['chat'], { from: 'user' })
    const output = jest.mocked(process.stdout.write).mock.calls.map(([text]) => String(text)).join('')
    expect(output).toContain('[Hook SessionStart] Session started')
    expect(output).toContain('[Hook SessionEnd] Session ended')
})
