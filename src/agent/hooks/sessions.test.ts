import { HookEngine, HookInjection, HookSessions } from './engine'

let hooks: HookEngine
let run: jest.SpiedFunction<HookEngine['run']>
let sessions: HookSessions
let inbox: Map<string, HookInjection[]>

beforeEach(async () => {
    hooks = await HookEngine.load({ cwd: process.cwd(), hooksPath: 'src/agent/hooks/hooks.json' })
    run = jest.spyOn(hooks, 'run').mockResolvedValue({ blocked: false, injections: [] })
    jest.spyOn(HookEngine, 'load').mockResolvedValue(hooks)
    inbox = new Map()
    sessions = new HookSessions({ append: (id, injections) =>
        inbox.set(id, [...inbox.get(id) ?? [], ...injections]) })
})
afterEach(() => jest.restoreAllMocks())

it('starts once per activation, including concurrent starts, and ends only once', async () => {
    await Promise.all([
        sessions.start('thread', { reason: 'startup', hooksPath: 'custom.json' }),
        sessions.start('thread'),
    ])
    await sessions.start('thread')
    expect(run).toHaveBeenCalledTimes(1)
    expect(await sessions.get('thread')).toBe(hooks)
    expect(run.mock.calls[0][0]).toMatchObject({ event: 'SessionStart', reason: 'startup', sessionId: 'thread' })
    expect(HookEngine.load).toHaveBeenCalledWith(expect.objectContaining({ hooksPath: 'custom.json' }))
    await Promise.all([sessions.end('thread', 'exit'), sessions.end('thread', 'exit')])
    await sessions.end('thread', 'exit')
    expect(run.mock.calls.map(([input]) => input.event)).toEqual(['SessionStart', 'SessionEnd'])
    await expect(sessions.get('thread')).rejects.toThrow('not active')
    await sessions.start('thread', { reason: 'resume' })
    expect(run.mock.calls[2][0]).toMatchObject({ event: 'SessionStart', reason: 'resume' })
    expect(run.mock.calls[0][0].eventId).not.toBe(run.mock.calls[2][0].eventId)
})

it('rejects blocked starts and allows retry without ending the blocked activation', async () => {
    run.mockResolvedValueOnce({ blocked: true, error: 'start denied', injections: [] })
    await expect(sessions.start('thread')).rejects.toThrow('start denied')
    await sessions.end('thread', 'exit')
    expect(run).toHaveBeenCalledTimes(1)
    await sessions.start('thread')
    expect(run).toHaveBeenCalledTimes(2)
})

it('records start and end injections in order for the host to persist', async () => {
    run.mockImplementation(async input => ({ blocked: false, injections: [input.event] }))
    await sessions.start('thread')
    await sessions.end('thread', 'exit')
    await sessions.start('thread', { reason: 'resume' })
    expect(inbox.get('thread')?.map(injection => [injection.event, injection.text])).toEqual([
        ['SessionStart', 'SessionStart'], ['SessionEnd', 'SessionEnd'], ['SessionStart', 'SessionStart'],
    ])
    expect(new Set(inbox.get('thread')?.map(injection => injection.id)).size).toBe(3)
})

it('rejects cancelled and empty-ID starts without activating a session', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(sessions.start('thread', { signal: controller.signal }))
        .rejects.toMatchObject({ name: 'AbortError' })
    await expect(sessions.start('')).rejects.toThrow('thread ID')
    expect(run).not.toHaveBeenCalled()
})
