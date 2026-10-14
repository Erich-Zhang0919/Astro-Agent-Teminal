import { createAgentDisplay } from './tool-display'

it('keeps long arguments on one short line and never displays result contents', () => {
    const lines: string[] = []
    const display = createAgentDisplay(text => lines.push(text))
    const info = { name: 'exec', args: { command: 'x'.repeat(4000) + '\nnext line' } }
    display.onToolEvent({ ...info, type: 'start' })
    display.onToolEvent({ ...info, type: 'result', status: 'success', content: 'hidden output' })
    const output = lines.join('')
    expect(output).toContain('[Tool] exec called: ')
    expect(output).toContain('…')
    expect(output.trim().split('\n')).toHaveLength(1)
    expect(output.length).toBeLessThan(200)
    expect(output).not.toContain('hidden output')
    expect(output).not.toContain('next line')
})

it('shows short error and blocked statuses without result previews', () => {
    const lines: string[] = []
    const display = createAgentDisplay(text => lines.push(text))
    for (const status of ['error', 'blocked'] as const) {
        display.onToolEvent({ name: 'exec', args: {}, type: 'result', status, content: 'hidden failure' })
    }
    expect(lines.join('')).toBe('[Tool] exec: Error\n[Tool] exec: Blocked\n')
})

it('displays actual multiline stdout and stderr separately from assistant text', () => {
    const lines: string[] = []
    const display = createAgentDisplay(text => lines.push(text))
    display.onToken('first reply')
    display.onHookEvent({ event: 'PreToolUse', eventId: 'pre',
        stdout: 'Checking tool: exec\nSecond line\n', stderr: 'A warning' })
    display.onToken('second reply')
    display.finishReply()
    display.onToken('next turn')
    const output = lines.join('')
    expect(output).toBe('Astro: first reply\n[Hook PreToolUse] Checking tool: exec\n' +
        '[Hook PreToolUse] Second line\n[Hook PreToolUse] A warning\n' +
        'Astro: second reply\nAstro: next turn')
})

it('does not display anything for a silent script', () => {
    const write = jest.fn()
    const display = createAgentDisplay(write)
    display.onHookEvent({ event: 'PreToolUse', eventId: 'pre', stdout: '', stderr: '' })
    expect(write).not.toHaveBeenCalled()
})
