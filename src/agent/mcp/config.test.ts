import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadMcpConfiguration, resolveMcpEnvironment } from './config'

jest.mock('node:os', () => ({ ...jest.requireActual('node:os'), homedir: jest.fn() }))

let cwd: string
let home: string
let configurationPath: string
beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'astro-mcp-config-'))
    home = join(cwd, 'home')
    jest.mocked(homedir).mockReturnValue(home)
    await mkdir(join(home, '.astro'), { recursive: true })
    configurationPath = join(home, '.astro', 'astro.json')
})
afterEach(async () => { await rm(cwd, { recursive: true, force: true }) })

it('disables MCP for a missing default file but rejects a missing explicit file', async () => {
    expect((await loadMcpConfiguration(cwd)).servers).toEqual({})
    await expect(loadMcpConfiguration(cwd, 'missing.json')).rejects.toThrow('Cannot read MCP')
})

it('loads home configuration with other settings and resolves cwd against its directory', async () => {
    await writeFile(configurationPath, JSON.stringify({
        model: { apiKey: 'test-secret' }, env: {}, hooks: {}, mcpServers: {
            local: { command: 'node', cwd: '../work' },
            remote: { transport: 'streamable-http', url: 'http://localhost/mcp', enabled: false },
            session: { command: 'node' },
        },
    }))
    const config = await loadMcpConfiguration(cwd)
    expect(config.servers.local).toMatchObject({ transport: 'stdio', cwd: join(home, 'work'),
        enabled: true, autoApprove: [], connectTimeoutMs: 15_000, callTimeoutMs: 60_000 })
    expect(config.servers.session).toMatchObject({ cwd })
    expect(config.servers.remote.enabled).toBe(false)
})

it('disables MCP when astro.json has no mcpServers section and ignores project mcp.json', async () => {
    await writeFile(configurationPath, JSON.stringify({ model: {}, hooks: {} }))
    await mkdir(join(cwd, '.astro'))
    await writeFile(join(cwd, '.astro', 'mcp.json'), '{bad')
    expect((await loadMcpConfiguration(cwd)).servers).toEqual({})
})

it('honors an explicit path instead of reading the default home configuration', async () => {
    await writeFile(configurationPath, '{bad')
    await writeFile(join(cwd, 'custom.json'), JSON.stringify({ mcpServers: {
        local: { command: 'node', cwd: './work' },
    } }))
    expect((await loadMcpConfiguration(cwd, 'custom.json')).servers.local)
        .toMatchObject({ command: 'node', cwd: join(cwd, 'work') })
})

it('validates server entries from astro.json without exposing credentials', async () => {
    await writeFile(configurationPath, JSON.stringify({ model: { apiKey: 'test-secret' },
        mcpServers: { bad: { command: 'node', env: { TOKEN: 'test-secret' }, typo: true } },
    }))
    await expect(loadMcpConfiguration(cwd)).rejects.toThrow(`Invalid MCP configuration at mcpServers.bad: ${configurationPath}`)
    await expect(loadMcpConfiguration(cwd)).rejects.not.toThrow('test-secret')
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
