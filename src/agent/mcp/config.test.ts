import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadMcpConfiguration, resolveMcpEnvironment } from './config'

let cwd: string
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'astro-mcp-config-')) })
afterEach(async () => { await rm(cwd, { recursive: true, force: true }) })

it('disables MCP for a missing default file but rejects a missing explicit file', async () => {
    expect((await loadMcpConfiguration(cwd)).servers).toEqual({})
    await expect(loadMcpConfiguration(cwd, 'missing.json')).rejects.toThrow('Cannot read MCP')
})

it('infers stdio and resolves relative cwd against the configuration directory', async () => {
    await mkdir(join(cwd, '.astro'))
    await writeFile(join(cwd, '.astro/mcp.json'), JSON.stringify({ mcpServers: {
        local: { command: 'node', cwd: '../work' }, remote: { transport: 'streamable-http', url: 'http://localhost/mcp', enabled: false },
    } }))
    const config = await loadMcpConfiguration(cwd)
    expect(config.servers.local).toMatchObject({ transport: 'stdio', cwd: join(cwd, 'work'),
        enabled: true, autoApprove: [], connectTimeoutMs: 15_000, callTimeoutMs: 60_000 })
    expect(config.servers.remote.enabled).toBe(false)
})

it.each(['{', JSON.stringify({ mcpServers: { bad: { command: 'node', typo: true } } }),
    JSON.stringify({ mcpServers: { bad: { transport: 'streamable-http', url: 'file:///secret' } } }),
    JSON.stringify({ mcpServers: { bad: { command: 'node', callTimeoutMs: -1 } } }),
])('rejects malformed config without echoing values', async source => {
    await writeFile(join(cwd, 'config.json'), source)
    await expect(loadMcpConfiguration(cwd, 'config.json')).rejects.toThrow('Invalid MCP')
})

it('interpolates credentials and reports missing variable names without their values', () => {
    process.env.ASTRO_MCP_TEST_TOKEN = 'secret-value'
    expect(resolveMcpEnvironment({ Authorization: 'Bearer ${ASTRO_MCP_TEST_TOKEN}' }))
        .toEqual({ Authorization: 'Bearer secret-value' })
    delete process.env.ASTRO_MCP_TEST_TOKEN
    expect(() => resolveMcpEnvironment({ token: '${ASTRO_MCP_TEST_TOKEN}' })).toThrow('Missing environment variable: ASTRO_MCP_TEST_TOKEN')
})
