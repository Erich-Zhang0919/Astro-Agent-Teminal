import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HookEngine, HookInput, HookEventCallback } from './engine'

let directory: string
let scriptIndex = 0
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'astro-hooks-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

async function script(body: string): Promise<string> {
    const path = join(directory, `hook-${scriptIndex++}.js`)
    await writeFile(path, body)
    return `"${process.execPath}" "${path}"`
}

async function load(hooks: unknown, onDiagnostic?: (message: string) => void, onHookEvent?: HookEventCallback) {
    await mkdir(join(directory, '.astro'), { recursive: true })
    await writeFile(join(directory, '.astro', 'hooks.json'), JSON.stringify({ hooks }))
    return HookEngine.load({ cwd: directory, onDiagnostic, onHookEvent })
}

function input(event: HookInput['event'] = 'PreToolUse', name = 'remote_exec'): HookInput {
    const base = { version: 1 as const, eventId: 'stable-event', sessionId: 'session', cwd: directory }
    if (event === 'SessionStart') return { ...base, event, reason: 'startup' }
    if (event === 'SessionEnd') return { ...base, event, reason: 'exit' }
    const tool = { name, callId: 'call', args: { command: 'echo "$(untrusted)"' } }
    return event === 'PreToolUse' ? { ...base, event, tool }
        : { ...base, event, tool, result: { status: 'error', content: 'tool failure' } }
}

it('disables absent default configuration but rejects absent explicit paths', async () => {
    const engine = await HookEngine.load({ cwd: directory })
    await expect(engine.run(input())).resolves.toEqual({ blocked: false, injections: [] })
    await expect(HookEngine.load({ cwd: directory, hooksPath: 'missing.json' }))
        .rejects.toThrow('Cannot load hooks')
})

it.each([
    { UnexpectedEvent: [] },
    { SessionStart: [{ command: 'echo hello', matcher: '*' }] },
    { SessionEnd: [{ command: 'echo hello', extra: true }] },
    { PreToolUse: [{ command: '' }] },
    { PreToolUse: [{ command: 'echo hello', timeoutMs: 0 }] },
])('rejects invalid configurations: %j', async (hooks) => {
    await expect(load(hooks)).rejects.toThrow('Invalid hooks configuration')
})

it('rejects malformed JSON and honors an explicit relative path', async () => {
    await writeFile(join(directory, 'custom.json'), '{bad')
    await expect(HookEngine.load({ cwd: directory, hooksPath: 'custom.json' }))
        .rejects.toThrow('Invalid hooks configuration')
    await writeFile(join(directory, 'custom.json'), '{"hooks":{}}')
    await expect(HookEngine.load({ cwd: directory, hooksPath: 'custom.json' })).resolves.toBeDefined()
})

it('matches case-sensitive substrings, wildcard and omitted matchers', async () => {
    const command = await script('process.stderr.write("matched"); process.exit(2)')
    const engine = await load({ PreToolUse: [
        { matcher: 'exec', command }, { matcher: 'EXEC', command },
        { matcher: '*', command }, { command },
    ] })
    expect((await engine.run(input())).injections).toEqual(['matched', 'matched', 'matched'])
    expect((await engine.run(input('PreToolUse', 'read_file'))).injections)
        .toEqual(['matched', 'matched'])
})

it('passes JSON through stdin, runs in the configured cwd and ignores stdout', async () => {
    const command = await script(`
        let json = ''; process.stdin.on('data', chunk => json += chunk);
        process.stdin.on('end', () => {
            const value = JSON.parse(json);
            process.stdout.write('not conversation context');
            process.stderr.write(JSON.stringify({ value, cwd: process.cwd() }));
            process.exitCode = 2;
        });
    `)
    const engine = await load({ PostToolUse: [{ command }] })
    const payload = input('PostToolUse')
    const result = await engine.run(payload)
    expect(JSON.parse(result.injections[0])).toEqual({ value: payload, cwd: await realpath(directory) })
})

it('ignores stderr on exit 0 and short-circuits blocking hooks in order', async () => {
    const continued = await script('process.stderr.write("ignored"); process.exit(0)')
    const injected = await script('process.stderr.write("context\\n"); process.exit(2)')
    const blocked = await script('process.stderr.write("deny\\n"); process.exit(1)')
    const engine = await load({ PreToolUse: [
        { command: continued }, { command: injected }, { command: blocked }, { command: injected },
    ] })
    await expect(engine.run(input())).resolves.toEqual({
        blocked: true, error: 'deny\n', injections: ['context\n'],
    })
})

it.each(['PostToolUse', 'SessionEnd'] as const)(
    'reports %s failures and continues remaining hooks', async (event) => {
        const diagnostic = jest.fn()
        const command = await script('process.stderr.write("failed"); process.exit(1)')
        const injection = await script('process.stderr.write("next"); process.exit(2)')
        const engine = await load({ [event]: [{ command }, { command: injection }] }, diagnostic)
        await expect(engine.run(input(event))).resolves.toEqual({ blocked: false, injections: ['next'] })
        expect(diagnostic).toHaveBeenCalledWith('failed')
    },
)

it('blocks SessionStart and supplies a default error for empty stderr', async () => {
    const command = await script('process.exit(1)')
    const engine = await load({ SessionStart: [{ command }] })
    expect(await engine.run(input('SessionStart'))).toEqual({
        blocked: true, error: expect.stringContaining('without an error message'), injections: [],
    })
})

it('keeps its configuration snapshot after the file changes', async () => {
    const command = await script('process.stderr.write("snapshot"); process.exit(2)')
    const engine = await load({ PreToolUse: [{ command }] })
    await writeFile(join(directory, '.astro', 'hooks.json'), '{"hooks":{}}')
    expect((await engine.run(input())).injections).toEqual(['snapshot'])
})

it('reports actual output only from matching scripts in order and stops after a blocking script', async () => {
    const continued = await script('process.stdout.write("checking\\n"); process.exit(0)')
    const blocked = await script('process.stderr.write("deny"); process.exit(1)')
    const onHookEvent = jest.fn()
    const engine = await load({ PreToolUse: [
        { matcher: 'read_file', command: continued },
        { matcher: 'exec', command: continued },
        { matcher: '*', command: blocked },
        { command: continued },
    ] }, undefined, onHookEvent)
    expect((await engine.run(input())).blocked).toBe(true)
    expect(onHookEvent.mock.calls.map(([notice]) => notice)).toEqual([
        { event: 'PreToolUse', eventId: 'stable-event', stdout: 'checking\n', stderr: '' },
        { event: 'PreToolUse', eventId: 'stable-event', stdout: '', stderr: 'deny' },
    ])
})

it.each([0, 1, 2])('displays stdout and stderr without changing exit %i semantics', async code => {
    const onHookEvent = jest.fn()
    const command = await script(`process.stdout.write('Checking tool: 执行\\n');
        process.stderr.write('context'); process.exit(${code})`)
    const engine = await load({ PreToolUse: [{ command }] }, undefined, onHookEvent)
    const result = await engine.run(input())
    expect(onHookEvent).toHaveBeenCalledWith({ event: 'PreToolUse', eventId: 'stable-event',
        stdout: 'Checking tool: 执行\n', stderr: 'context' })
    expect(result).toEqual(code === 1 ? { blocked: true, error: 'context', injections: [] }
        : { blocked: false, injections: code === 2 ? ['context'] : [] })
})

it('does not notify for a silent script and reports output even when a script times out', async () => {
    const onHookEvent = jest.fn()
    const silent = await script('process.exit(0)')
    const waiting = await script('process.stdout.write("before timeout"); setInterval(() => {}, 10)')
    const engine = await load({ PreToolUse: [
        { command: silent }, { command: waiting, timeoutMs: 500 },
    ] }, undefined, onHookEvent)
    expect((await engine.run(input())).error).toContain('Timed out')
    expect(onHookEvent).toHaveBeenCalledTimes(1)
    expect(onHookEvent).toHaveBeenCalledWith({ event: 'PreToolUse', eventId: 'stable-event',
        stdout: 'before timeout', stderr: '' })
})

it('bounds displayed stdout while retaining the overflow failure', async () => {
    const onHookEvent = jest.fn()
    const command = await script('process.stdout.write("x".repeat(65537))')
    const engine = await load({ PreToolUse: [{ command }] }, undefined, onHookEvent)
    expect((await engine.run(input())).error).toContain('stdout exceeded')
    expect(Buffer.byteLength(onHookEvent.mock.calls[0][0].stdout)).toBe(65536)
})

it('still executes the hook if its display callback rejects', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
        const command = await script('process.stderr.write("deny"); process.exit(1)')
        const engine = await load({ PreToolUse: [{ command }] }, undefined,
            async () => { throw new Error('display failed') })
        await expect(engine.run(input())).resolves.toEqual({ blocked: true, error: 'deny', injections: [] })
        expect(error).toHaveBeenCalledWith('Hook event callback failed: display failed')
    } finally {
        error.mockRestore()
    }
})

it.each([
    ['invalid exit', 'process.exit(7)', 'invalid exit code 7'],
    ['stdout overflow', 'process.stdout.write("x".repeat(65537))', 'stdout exceeded'],
    ['stderr overflow', 'process.stderr.write("x".repeat(65537)); process.exitCode = 2', 'stderr exceeded'],
])('blocks on %s', async (_name, body, error) => {
    const engine = await load({ PreToolUse: [{ command: await script(body) }] })
    const result = await engine.run(input())
    expect(result.blocked).toBe(true)
    expect(result.error).toContain(error)
})

it('blocks on timeout and reports faults without blocking post hooks', async () => {
    const command = await script('process.on("SIGTERM", () => {}); setInterval(() => {}, 10)')
    const diagnostic = jest.fn()
    const engine = await load({
        PreToolUse: [{ command, timeoutMs: 100 }],
        PostToolUse: [{ command, timeoutMs: 100 }],
    }, diagnostic)
    expect((await engine.run(input())).error).toContain('Timed out')
    expect((await engine.run(input('PostToolUse'))).blocked).toBe(false)
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('Timed out'))
})

it('propagates cancellation instead of allowing the tool', async () => {
    const engine = await load({ PreToolUse: [{
        command: await script('setInterval(() => {}, 10)'),
    }] })
    const controller = new AbortController()
    const running = engine.run(input(), controller.signal)
    const timer = setTimeout(() => controller.abort(), 50)
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    clearTimeout(timer)
    await expect(engine.run(input(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
})

const unixTest = process.platform === 'win32' ? it.skip : it
unixTest('kills descendant processes when cancelled', async () => {
    const descendant = `const fs = require('node:fs'); setInterval(() => fs.appendFileSync('ticks', '.'), 10)`
    const command = await script(`
        require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}],
            { stdio: 'inherit' });
        setInterval(() => {}, 10);
    `)
    const engine = await load({ PreToolUse: [{ command }] })
    const controller = new AbortController()
    const running = engine.run(input(), controller.signal).catch(error => error)
    try {
        const deadline = Date.now() + 2000
        while (true) {
            try { await readFile(join(directory, 'ticks')); break } catch {
                if (Date.now() > deadline) throw new Error('Descendant did not start.')
                await new Promise(resolve => setTimeout(resolve, 10))
            }
        }
        controller.abort()
        expect(await running).toMatchObject({ name: 'AbortError' })
        const stopped = await readFile(join(directory, 'ticks'), 'utf8')
        await new Promise(resolve => setTimeout(resolve, 80))
        expect(await readFile(join(directory, 'ticks'), 'utf8')).toBe(stopped)
    } finally {
        controller.abort()
        await running
    }
})
