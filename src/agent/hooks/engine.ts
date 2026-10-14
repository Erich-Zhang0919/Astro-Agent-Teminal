import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'

export type HookEvent = 'SessionStart' | 'SessionEnd' | 'PreToolUse' | 'PostToolUse'
export type SessionStartReason = 'startup' | 'new' | 'resume' | 'ask'
export type SessionEndReason = 'exit' | 'switch' | 'ask_completed' | 'error'

export interface HookExecutionEvent {
    event: HookEvent
    eventId: string
    stdout: string
    stderr: string
}

export type HookEventCallback = (event: HookExecutionEvent) => void | Promise<void>

interface HookBase {
    version: 1
    eventId: string
    sessionId: string
    cwd: string
}

interface HookTool {
    name: string
    callId?: string
    args: Record<string, unknown>
}

export type HookInput = HookBase & (
    | { event: 'SessionStart'; reason: SessionStartReason }
    | { event: 'SessionEnd'; reason: SessionEndReason }
    | { event: 'PreToolUse'; tool: HookTool }
    | { event: 'PostToolUse'; tool: HookTool; result: {
        status: 'success' | 'error'
        content: unknown
    } }
)

export interface HookResult {
    blocked: boolean
    error?: string
    injections: string[]
}

export interface HookInjection {
    id: string
    event: HookEvent
    text: string
}

export function hookInjections(
    event: HookEvent, eventId: string, texts: string[],
): HookInjection[] {
    return texts.map((text, index) => ({ id: `hook:${eventId}:${index}`, event, text }))
}

export interface HookLoadOptions {
    cwd: string
    hooksPath?: string
    onDiagnostic?: (message: string) => void
    onHookEvent?: HookEventCallback
}

export interface HookSessionOptions {
    hooksPath?: string
    onHookDiagnostic?: (message: string) => void
    onHookEvent?: HookEventCallback
    reason?: SessionStartReason
    signal?: AbortSignal
}

/** Framework-independent activation lifecycle; the host supplies its durable inbox. */
export class HookSessions {
    private readonly active = new Map<string, Promise<{ hooks: HookEngine; activationId: string }>>()
    private readonly ending = new Map<string, Promise<void>>()

    constructor(private readonly inbox: {
        append(sessionId: string, injections: HookInjection[]): void
    }) {}

    async start(sessionId: string, options: HookSessionOptions = {}): Promise<void> {
        if (!sessionId) throw new Error('A thread ID is required to start an agent session.')
        options.signal?.throwIfAborted()
        await this.ending.get(sessionId)
        const existing = this.active.get(sessionId)
        if (existing) {
            await existing
            options.signal?.throwIfAborted()
            return
        }
        const activation = (async () => {
            const activationId = randomUUID()
            const hooks = await HookEngine.load({ cwd: process.cwd(),
                hooksPath: options.hooksPath, onDiagnostic: options.onHookDiagnostic,
                onHookEvent: options.onHookEvent })
            const eventId = `${activationId}:SessionStart`
            const result = await hooks.run({
                version: 1, event: 'SessionStart', eventId, sessionId,
                cwd: hooks.cwd, reason: options.reason ?? 'startup',
            }, options.signal)
            if (result.blocked) throw new Error(result.error ?? 'SessionStart hook blocked this session.')
            this.inbox.append(sessionId, hookInjections('SessionStart', eventId, result.injections))
            return { hooks, activationId }
        })()
        this.active.set(sessionId, activation)
        try {
            await activation
        } catch (error) {
            if (this.active.get(sessionId) === activation) this.active.delete(sessionId)
            throw error
        }
    }

    async get(sessionId: string): Promise<HookEngine> {
        const activation = this.active.get(sessionId)
        if (!activation) throw new Error(`Agent session is not active: ${sessionId}`)
        return (await activation).hooks
    }

    async end(sessionId: string, reason: SessionEndReason): Promise<void> {
        const ending = this.ending.get(sessionId)
        if (ending) return ending
        const activation = this.active.get(sessionId)
        if (!activation) return
        const completion = (async () => {
            const { hooks, activationId } = await activation
            const eventId = `${activationId}:SessionEnd`
            const result = await hooks.run({
                version: 1, event: 'SessionEnd', eventId, sessionId, cwd: hooks.cwd, reason,
            })
            this.inbox.append(sessionId, hookInjections('SessionEnd', eventId, result.injections))
        })()
        this.ending.set(sessionId, completion)
        try {
            await completion
        } finally {
            if (this.active.get(sessionId) === activation) this.active.delete(sessionId)
            this.ending.delete(sessionId)
        }
    }
}

const commandSchema = z.object({
    command: z.string().trim().min(1),
    timeoutMs: z.number().int().positive().max(2_147_483_647).default(10_000),
}).strict()
const toolHookSchema = commandSchema.extend({ matcher: z.string().optional() })
const configSchema = z.object({
    hooks: z.object({
        SessionStart: z.array(commandSchema).optional(),
        SessionEnd: z.array(commandSchema).optional(),
        PreToolUse: z.array(toolHookSchema).optional(),
        PostToolUse: z.array(toolHookSchema).optional(),
    }).strict(),
}).strict()

type HookConfig = z.infer<typeof configSchema>['hooks']
type HookCommand = z.infer<typeof toolHookSchema>
const OUTPUT_LIMIT = 64 * 1024

/** Local extensions run outside the agent's tool dispatcher, so they cannot recurse. */
export class HookEngine {
    private constructor(
        private readonly config: HookConfig,
        readonly cwd: string,
        private readonly onDiagnostic?: (message: string) => void,
        private readonly onHookEvent?: HookEventCallback,
    ) {}

    static async load(options: HookLoadOptions): Promise<HookEngine> {
        const cwd = resolve(options.cwd)
        const path = resolve(cwd, options.hooksPath ?? '.astro/hooks.json')
        let source: string
        try {
            source = await readFile(path, 'utf8')
        } catch (error) {
            if (options.hooksPath === undefined &&
                (error as NodeJS.ErrnoException).code === 'ENOENT') {
                return new HookEngine({}, cwd, options.onDiagnostic, options.onHookEvent)
            }
            throw new Error(`Cannot load hooks from ${path}: ${(error as Error).message}`)
        }
        try {
            return new HookEngine(configSchema.parse(JSON.parse(source)).hooks,
                cwd, options.onDiagnostic, options.onHookEvent)
        } catch (error) {
            throw new Error(`Invalid hooks configuration ${path}: ${(error as Error).message}`)
        }
    }

    async run(input: HookInput, signal?: AbortSignal): Promise<HookResult> {
        signal?.throwIfAborted()
        const result: HookResult = { blocked: false, injections: [] }
        const blocking = input.event === 'PreToolUse' || input.event === 'SessionStart'
        const hooks: HookCommand[] = this.config[input.event] ?? []
        for (const hook of hooks) {
            signal?.throwIfAborted()
            if ('tool' in input && hook.matcher !== undefined && hook.matcher !== '*' &&
                !input.tool.name.includes(hook.matcher)) continue

            let failure: string | undefined
            try {
                const output = await executeHook(hook, { ...input, cwd: this.cwd }, signal, async output => {
                    if (!output.stdout && !output.stderr) return
                    // Observers are presentation only; failures cannot change hook policy.
                    try {
                        await this.onHookEvent?.({ event: input.event, eventId: input.eventId,
                            ...output })
                    } catch (error) {
                        console.error(`Hook event callback failed: ${error instanceof Error ? error.message : String(error)}`)
                    }
                })
                signal?.throwIfAborted()
                if (output.code === 2) {
                    if (output.stderr) result.injections.push(output.stderr)
                } else if (output.code === 1) {
                    failure = output.stderr || `${input.event} hook blocked without an error message.`
                } else if (output.code !== 0) {
                    failure = `${input.event} hook returned invalid exit code ${output.code}.` +
                        (output.stderr ? `\n${output.stderr}` : '')
                }
            } catch (error) {
                signal?.throwIfAborted()
                failure = `${input.event} hook failed: ${(error as Error).message}`
            }
            if (failure !== undefined) {
                if (blocking) return { ...result, blocked: true, error: failure }
                if (this.onDiagnostic) this.onDiagnostic(failure)
                else console.error(failure)
            }
        }
        return result
    }
}

function executeHook(
    hook: HookCommand,
    input: HookInput,
    signal?: AbortSignal,
    onOutput?: (output: { stdout: string; stderr: string }) => Promise<void>,
): Promise<{ code: number | null; stderr: string }> {
    const payload = JSON.stringify(input)
    return new Promise((resolveOutput, reject) => {
        const child = spawn(hook.command, {
            cwd: input.cwd,
            shell: true,
            detached: process.platform !== 'win32',
            stdio: ['pipe', 'pipe', 'pipe'],
        })
        let failure: Error | undefined
        let aborted = false
        let stdoutBytes = 0
        let stderrBytes = 0
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        let treeKill: Promise<void> | undefined

        const terminate = () => {
            if (!child.pid || treeKill) return
            if (process.platform === 'win32') {
                treeKill = new Promise((done) => {
                    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'],
                        { stdio: 'ignore' })
                    killer.once('error', () => { child.kill('SIGKILL'); done() })
                    killer.once('close', () => done())
                })
            } else {
                try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL')
                }
                treeKill = Promise.resolve()
            }
        }
        const fail = (error: Error) => {
            failure ??= error
            terminate()
        }
        const onAbort = () => {
            aborted = true
            terminate()
        }
        const timer = setTimeout(() => fail(new Error(`Timed out after ${hook.timeoutMs}ms.`)),
            hook.timeoutMs)
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted) onAbort()

        child.stdout.on('data', (chunk: Buffer) => {
            const remaining = OUTPUT_LIMIT - stdoutBytes
            if (remaining > 0) stdout.push(chunk.subarray(0, remaining))
            stdoutBytes += chunk.length
            if (stdoutBytes > OUTPUT_LIMIT) fail(new Error('stdout exceeded 64 KiB.'))
        })
        child.stderr.on('data', (chunk: Buffer) => {
            stderrBytes += chunk.length
            if (stderrBytes > OUTPUT_LIMIT) fail(new Error('stderr exceeded 64 KiB.'))
            else stderr.push(chunk)
        })
        child.on('error', fail)
        child.stdin.on('error', (error: NodeJS.ErrnoException) => {
            // A command may exit without reading stdin; its exit code still decides the outcome.
            if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') fail(error)
        })
        child.once('close', async (code) => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            await treeKill
            const stderrText = Buffer.concat(stderr).toString('utf8')
            await onOutput?.({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: stderrText })
            if (aborted) {
                const error = new Error('Hook execution cancelled.')
                error.name = 'AbortError'
                reject(error)
            } else if (failure) reject(failure)
            else resolveOutput({ code, stderr: stderrText })
        })
        child.stdin.end(payload)
    })
}
