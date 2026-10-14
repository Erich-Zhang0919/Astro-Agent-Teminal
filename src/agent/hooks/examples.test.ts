import { resolve } from 'node:path'
import { HookEngine, HookInput } from './engine'

it('runs every script referenced by the checked-in hook configuration', async () => {
    const cwd = resolve(__dirname, '../../..')
    const diagnostic = jest.fn()
    const onHookEvent = jest.fn()
    const engine = await HookEngine.load({
        cwd, hooksPath: 'src/agent/hooks/hooks.json', onDiagnostic: diagnostic, onHookEvent,
    })
    const base = { version: 1 as const, sessionId: 'example-session', cwd }
    const tool = { name: 'exec', callId: 'example-call', args: { command: 'echo hello' } }
    const inputs: HookInput[] = [
        { ...base, eventId: 'start', event: 'SessionStart', reason: 'startup' },
        { ...base, eventId: 'pre', event: 'PreToolUse', tool },
        { ...base, eventId: 'post', event: 'PostToolUse', tool,
            result: { status: 'success', content: 'hello' } },
        { ...base, eventId: 'end', event: 'SessionEnd', reason: 'exit' },
    ]
    for (const input of inputs) {
        await expect(engine.run(input)).resolves.toEqual({ blocked: false, injections: [] })
    }
    expect(diagnostic).not.toHaveBeenCalled()
    expect(onHookEvent.mock.calls.map(([notice]) => [notice.event, notice.stdout, notice.stderr])).toEqual([
        ['SessionStart', 'Session started: example-session\n', ''],
        ['PreToolUse', 'Checking tool: exec\n', ''],
        ['PostToolUse', 'Tool completed: exec (success)\n', ''],
        ['SessionEnd', 'Session ended: example-session (exit)\n', ''],
    ])
    expect(onHookEvent.mock.calls.every(([notice]) => !('command' in notice))).toBe(true)
})
