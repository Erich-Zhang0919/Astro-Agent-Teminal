import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, Server } from 'node:http'
import { ToolMessage } from '@langchain/core/messages'
import { McpManager } from './manager'
import { loadMcpConfiguration } from './config'
import { mcpToolName } from './adapter'

const fixture = resolve(__dirname, 'fixtures/server.cjs')
const { createHandler } = require('./fixtures/server.cjs')
let cwd: string
let managers: McpManager[]
let http: Server | undefined
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'astro-mcp-')); managers = [] })
afterEach(async () => {
    await Promise.all(managers.map(manager => manager.close()))
    if (http) { http.closeAllConnections(); await new Promise<void>(resolve => http!.close(() => resolve())); http = undefined }
    await rm(cwd, { recursive: true, force: true })
})

async function start(servers: Record<string, unknown>, diagnostic = jest.fn()) {
    await writeFile(join(cwd, 'config.json'), JSON.stringify({ mcpServers: servers }))
    const manager = new McpManager(await loadMcpConfiguration(cwd, 'config.json'), diagnostic)
    managers.push(manager)
    await manager.start()
    return manager
}
const local = (extra = {}) => ({ command: process.execPath, args: [fixture], connectTimeoutMs: 5000, ...extra })
async function call(manager: McpManager, name: string, args = {}, signal?: AbortSignal) {
    const item = manager.tools.find(item => item.mcp.toolName === name)!
    return await item.invoke({ name: item.name, args, id: `test-${name}`, type: 'tool_call' }, { signal }) as ToolMessage
}

it('discovers paginated stdio tools, preserves schema and forwards original names', async () => {
    const manager = await start({ local: local({ autoApprove: ['echo'] }) })
    expect(manager.tools).toHaveLength(9)
    const echo = manager.tools.find(item => item.mcp.toolName === 'echo')!
    expect(echo.name).toBe('mcp__local__echo')
    expect(echo.mcp.autoApprove).toBe(true)
    expect(manager.tools.find(item => item.mcp.toolName === 'counter')!.mcp.autoApprove).toBe(false)
    const args = { payload: { mode: 'one', items: [1, 2] } }
    expect((await call(manager, 'echo', args)).content).toBe(JSON.stringify(args))
    await expect(call(manager, 'echo', { payload: { mode: 'wrong', items: [1] } })).rejects.toThrow()
})

it('negotiates the modern protocol without requiring a legacy initialize handshake', async () => {
    const manager = await start({ modern: local({ env: { MCP_FIXTURE_MODERN: 'yes' } }) })
    expect(manager.getStatus()[0].status).toBe('connected')
    expect((await call(manager, 'counter')).content).toBe('1')
})

it('reports tool list changes without replacing the session catalog', async () => {
    const diagnostic = jest.fn()
    const manager = await start({ local: local() }, diagnostic)
    const original = [...manager.tools]
    await call(manager, 'notify')
    expect(manager.tools).toEqual(original)
    expect(JSON.stringify(diagnostic.mock.calls)).toContain('Re-enter the session to update tools')
})

it('uses a discovery deadline and tears down a cancelled startup', async () => {
    const manager = await start({ slow: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], connectTimeoutMs: 100 } })
    expect(manager.getStatus()[0]).toMatchObject({ status: 'failed', error: 'Connection or discovery timed out.' })
    const config = await loadMcpConfiguration(cwd, 'config.json')
    config.servers.slow.connectTimeoutMs = 5000
    const cancelled = new McpManager(config)
    managers.push(cancelled)
    const controller = new AbortController()
    const starting = cancelled.start(controller.signal)
    const rejected = expect(starting).rejects.toThrow('startup cancelled')
    controller.abort(new Error('startup cancelled'))
    await rejected
})

it('preserves tool failures, structured output and saves binary attachments', async () => {
    const manager = await start({ local: local({ autoApprove: ['*'] }) })
    expect(manager.tools.every(item => item.mcp.autoApprove)).toBe(true)
    expect(await call(manager, 'error')).toMatchObject({ status: 'error', content: 'fixture tool error' })
    expect((await call(manager, 'structured')).content).toContain('"total": 42')
    const result = await call(manager, 'attachment')
    expect(result.content).toContain('Resource link: test://link')
    expect(result.content).not.toContain(Buffer.from('fixture image').toString('base64'))
    const files = await readdir(join(cwd, 'tool_output'))
    expect(files).toHaveLength(2)
    expect(await readFile(join(cwd, 'tool_output', files.find(name => name.endsWith('.png'))!), 'utf8')).toBe('fixture image')
})

it('isolates failed and disabled servers and hides secrets from diagnostics', async () => {
    const diagnostic = jest.fn()
    const manager = await start({ good: local(), disabled: local({ enabled: false }),
        bad: { command: 'missing-command-secret-token', env: { TOKEN: 'secret-token' } },
        missing: local({ env: { TOKEN: '${ASTRO_MCP_NONEXISTENT_TEST}' } }),
    }, diagnostic)
    expect(manager.getStatus().map(item => [item.serverId, item.status])).toEqual([
        ['good', 'connected'], ['disabled', 'disabled'], ['bad', 'failed'], ['missing', 'failed'],
    ])
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('secret-token')
    expect((await call(manager, 'counter')).content).toBe('1')
})

it('skips duplicate and invalid schemas and uses stable legal tool names', async () => {
    const diagnostic = jest.fn()
    const manager = await start({ 'with.dots': local({ env: { MCP_FIXTURE_BAD_TOOLS: 'yes' } }) }, diagnostic)
    expect(manager.tools.some(item => ['echo', 'bad'].includes(item.mcp.toolName))).toBe(false)
    expect(manager.tools.every(item => /^[a-zA-Z0-9_-]{1,64}$/.test(item.name))).toBe(true)
    expect(mcpToolName('server', 'a'.repeat(100))).toHaveLength(64)
    expect(mcpToolName('a.b', 'tool')).not.toBe(mcpToolName('a_b', 'tool'))
    expect(JSON.stringify(diagnostic.mock.calls)).toContain('unsupported schema')
})

it('cancels queued work, times out without retry, and keeps a usable connection', async () => {
    const manager = await start({ local: local({ callTimeoutMs: 80 }) })
    const first = call(manager, 'slow')
    const controller = new AbortController()
    const queued = call(manager, 'counter', {}, controller.signal)
    const cancelled = expect(queued).rejects.toThrow('cancelled')
    controller.abort(new Error('cancelled'))
    await cancelled
    expect(await first).toMatchObject({ status: 'error' })
    expect((await call(manager, 'counter')).content).toBe('1')
    expect(manager.getStatus()[0].status).toBe('connected')
})

it('releases the stdio process and reports disconnect without replaying', async () => {
    const pidFile = join(cwd, 'pid')
    const manager = await start({ local: local({ env: { MCP_FIXTURE_PID_FILE: pidFile } }) })
    const pid = Number(await readFile(pidFile, 'utf8'))
    const disconnected = await call(manager, 'disconnect')
    expect(disconnected.status).toBe('error')
    expect(manager.getStatus()[0].status).toBe('disconnected')
    await manager.close()
    expect(() => process.kill(pid, 0)).toThrow()
    await manager.close()
})

it('connects over Streamable HTTP with static headers and terminates its session', async () => {
    const handle = createHandler()
    const methods: string[] = []
    const auth: string[] = []
    http = createServer(async (req, res) => {
        methods.push(req.method!)
        auth.push(String(req.headers.authorization))
        if (req.method === 'DELETE') { res.writeHead(200).end(); return }
        if (req.method !== 'POST') { res.writeHead(405).end(); return }
        let body = ''
        for await (const chunk of req) body += chunk
        const message = JSON.parse(body)
        if (message.id === undefined) { res.writeHead(202).end(); return }
        await handle(message, (response: unknown) => {
            res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': 'fixture-session' })
            res.end(JSON.stringify(response))
        })
    })
    await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve))
    const port = (http.address() as { port: number }).port
    const manager = await start({ remote: { transport: 'streamable-http', url: `http://127.0.0.1:${port}/mcp`,
        headers: { Authorization: 'Bearer fixture-token' }, connectTimeoutMs: 5000 } })
    expect(manager.getStatus()[0].status).toBe('connected')
    expect((await call(manager, 'counter')).content).toBe('1')
    await manager.close()
    expect(methods).toContain('DELETE')
    expect(auth.every(value => value === 'Bearer fixture-token')).toBe(true)
})
