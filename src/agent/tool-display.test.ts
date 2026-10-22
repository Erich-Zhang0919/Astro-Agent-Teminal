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

it('shows structured blocking reasons without exposing result previews', () => {
    const lines: string[] = []
    const display = createAgentDisplay(text => lines.push(text))
    display.onToolEvent({ name: 'exec', args: {}, type: 'result', status: 'error', content: 'hidden failure' })
    display.onToolEvent({ name: 'exec', args: {}, type: 'result', status: 'blocked', content: 'hidden failure',
        reason: { source: 'permission', code: 'outside_workspace', message: 'Blocked: Command leaves the project.' } })
    expect(lines.join('')).toBe('[Tool] exec: Error\n[Tool] exec: Blocked [permission/outside_workspace]: Command leaves the project.\n')
    expect(lines.join('')).not.toContain('hidden failure')
})

it('bounds multiline hook blocking reasons to one notice', () => {
    const lines: string[] = []
    const display = createAgentDisplay(text => lines.push(text))
    display.onToolEvent({ name: 'read_file', args: {}, type: 'result', status: 'blocked', content: 'hidden output',
        reason: { source: 'hook', code: 'hook_blocked', message: 'Hook denied\n' + 'x'.repeat(1000) } })
    expect(lines.join('')).toContain('[hook/hook_blocked]: Hook denied ')
    expect(lines.join('').trim().split('\n')).toHaveLength(1)
    expect(lines.join('').length).toBeLessThan(250)
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
