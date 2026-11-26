import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

jest.mock('node:os', () => ({ ...jest.requireActual('node:os'), homedir: jest.fn() }))
jest.mock('uuid', () => ({ v5: jest.fn(), v6: jest.fn() }), { virtual: true })

let home: string
let installer: typeof import('./install')
let config: typeof import('./agent/config')
let fetchMock: jest.SpyInstance
let log: jest.SpyInstance

const skillMarkdown = (name: string) => `---\nname: ${name}\ndescription: Test ${name}\n---\nInstructions\n`
const sourceFiles: Record<string, Record<string, string | Buffer>> = {
    'vercel-labs/skills': { 'skills/find-skills/SKILL.md': skillMarkdown('find-skills') },
    'anthropics/skills': {
        'skills/skill-creator/SKILL.md': skillMarkdown('skill-creator'),
        'skills/skill-creator/scripts/helper.py': 'print("fixture")\n',
        'skills/skill-creator/assets/example.bin': Buffer.from([0, 255, 128, 42]),
    },
}

function treeFor(repository: string) {
    return { truncated: false, tree: [
        ...Object.keys(sourceFiles[repository]).map(path => ({
            path, type: 'blob', mode: path.endsWith('.py') ? '100755' : '100644',
        })),
        { path: 'README.md', type: 'blob', mode: '100644' },
        { path: 'skills/other/SKILL.md', type: 'blob', mode: '100644' },
    ] }
}

async function successfulDownload(input: string | URL | Request): Promise<Response> {
    const url = String(input)
    for (const [repository, files] of Object.entries(sourceFiles)) {
        if (url === `https://api.github.com/repos/${repository}/git/trees/main?recursive=1`) {
            return Response.json(treeFor(repository))
        }
        const prefix = `https://raw.githubusercontent.com/${repository}/main/`
        if (url.startsWith(prefix)) {
            const content = files[url.slice(prefix.length)]
            if (content !== undefined) return new Response(new Uint8Array(Buffer.from(content)))
        }
    }
    throw new Error(`Unexpected download: ${url}`)
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'astro install-'))
    jest.isolateModules(() => {
        require('node:os').homedir.mockReturnValue(home)
        installer = require('./install')
        config = require('./agent/config')
    })
    fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(successfulDownload)
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
})

afterEach(() => {
    jest.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
})

it('initializes the database and copies complete skill directories before writing an empty-key configuration', async () => {
    await expect(installer.installIfNeeded()).resolves.toBe(true)

    expect(JSON.parse(readFileSync(config.CONFIG_PATH, 'utf8'))).toEqual({
        model: { model: 'kimi-k2.6', apiKey: '', baseURL: 'https://api.moonshot.cn/v1' },
        env: { TAVILY_API_KEY: '' },
    })
    if (process.platform !== 'win32') expect(statSync(config.CONFIG_PATH).mode & 0o777).toBe(0o600)
    const skills = join(config.WORKSPACE_DIR, '.agents', 'skills')
    expect(readdirSync(skills).sort()).toEqual(['find-skills', 'skill-creator'])
    expect(readFileSync(join(skills, 'find-skills', 'SKILL.md'), 'utf8')).toBe(skillMarkdown('find-skills'))
    expect(readFileSync(join(skills, 'skill-creator', 'scripts', 'helper.py'), 'utf8')).toBe('print("fixture")\n')
    expect(readFileSync(join(skills, 'skill-creator', 'assets', 'example.bin'))).toEqual(Buffer.from([0, 255, 128, 42]))
    if (process.platform !== 'win32') {
        expect(statSync(join(skills, 'skill-creator', 'scripts', 'helper.py')).mode & 0o777).toBe(0o755)
    }
    const saver = installer.initializeDatabase()
    try {
        expect(saver.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all())
            .toEqual(expect.arrayContaining([{ name: 'memory' }, { name: 'memory_fts' },
                { name: 'checkpoints' }, { name: 'writes' }]))
    } finally {
        saver.db.close()
    }
    expect(fetchMock).toHaveBeenCalledTimes(6)
})

it('prints welcome and step summaries without per-file noise, followed by configuration guidance', async () => {
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
        expect(log.mock.calls.flat().join('\n')).toContain('[2/3] 正在安装默认 skills')
        expect(existsSync(installer.DB_PATH)).toBe(true)
        expect(existsSync(config.CONFIG_PATH)).toBe(false)
        return successfulDownload(input)
    })
    await installer.installIfNeeded()
    const output = log.mock.calls.flat().join('\n')
    expect(output).toContain('🚀 欢迎使用 Astro')
    expect(output).toContain('[1/3] 正在初始化数据库')
    expect(output).toContain('📦 find-skills 安装完成')
    expect(output).toContain('📦 skill-creator 安装完成')
    expect(output).not.toContain('assets/example.bin')
    expect(output).not.toContain('\u001b[')
    expect(output).toContain('[3/3] 配置文件创建完成')
    expect(output).toContain('🎉 工作空间已准备好')
    expect(output).toContain(config.CONFIG_PATH)
    expect(output).toContain('https://astro-aiagent.vercel.app/docs/')
    expect(output).toContain('重新运行 astro chat')
})

it('uses configuration existence alone and skips installation without touching existing data', async () => {
    mkdirSync(config.WORKSPACE_DIR)
    writeFileSync(config.CONFIG_PATH, 'existing configuration, even if invalid')
    await expect(installer.installIfNeeded()).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    expect(existsSync(installer.DB_PATH)).toBe(false)
    expect(readFileSync(config.CONFIG_PATH, 'utf8')).toBe('existing configuration, even if invalid')
})

it('preserves existing database contents during installation and later startup', async () => {
    const first = installer.initializeDatabase()
    first.db.prepare('INSERT INTO memory(type, content, keywords) VALUES (?, ?, ?)')
        .run('fact', 'existing memory', 'existing')
    first.db.close()

    await installer.installIfNeeded()
    const second = installer.initializeDatabase()
    try {
        expect(second.db.prepare("SELECT content FROM memory_fts WHERE memory_fts MATCH 'existing'").all())
            .toEqual([{ content: 'existing memory' }])
    } finally {
        second.db.close()
    }
})

it('reports a database failure without downloading skills or creating a config', async () => {
    mkdirSync(config.WORKSPACE_DIR)
    writeFileSync(join(config.WORKSPACE_DIR, '.data'), 'not a directory')
    await expect(installer.installIfNeeded()).rejects.toThrow('首次安装失败（初始化数据库）')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(existsSync(config.CONFIG_PATH)).toBe(false)
})

it('reports HTTP failures and leaves the config absent so installation can retry', async () => {
    fetchMock.mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
    await expect(installer.installIfNeeded()).rejects.toThrow('HTTP 503')
    expect(log.mock.calls.flat().join('\n')).toContain('❌ 安装 skills未完成')
    expect(existsSync(config.CONFIG_PATH)).toBe(false)
    await expect(installer.installIfNeeded()).resolves.toBe(true)
})

it('cleans partial skill downloads and reuses completed skills on retry', async () => {
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
        if (String(input).endsWith('scripts/helper.py')) throw new Error('connection lost')
        return successfulDownload(input)
    })
    await expect(installer.installIfNeeded()).rejects.toThrow('connection lost')
    const skills = join(config.WORKSPACE_DIR, '.agents', 'skills')
    expect(readdirSync(skills)).toEqual(['find-skills'])
    expect(existsSync(config.CONFIG_PATH)).toBe(false)
    const existing = join(skills, 'find-skills', 'SKILL.md')
    writeFileSync(existing, 'locally edited skill')

    fetchMock.mockClear().mockImplementation(successfulDownload)
    await expect(installer.installIfNeeded()).resolves.toBe(true)
    expect(readFileSync(existing, 'utf8')).toBe('locally edited skill')
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('vercel-labs'))).toBe(true)
})

it.each([
    ['truncated tree', { truncated: true, tree: [] }],
    ['missing skill manifest', { truncated: false, tree: [] }],
])('rejects an incomplete download listing: %s', async (_label, tree) => {
    fetchMock.mockResolvedValueOnce(Response.json(tree))
    await expect(installer.installIfNeeded()).rejects.toThrow('首次安装失败（安装 skills）')
    expect(existsSync(config.CONFIG_PATH)).toBe(false)
})

it.each([
    ['skills/find-skills/../../outside.txt', '100644'],
    ['skills/find-skills/..\\outside.txt', '100644'],
    ['skills/find-skills/link', '120000'],
])('rejects unsafe archive paths or symlinks: %s', async (path, mode) => {
    const tree = treeFor('vercel-labs/skills')
    tree.tree.push({ path, mode, type: 'blob' })
    fetchMock.mockResolvedValueOnce(Response.json(tree))
    await expect(installer.installIfNeeded()).rejects.toThrow('包含不支持的路径')
    expect(readdirSync(join(config.WORKSPACE_DIR, '.agents', 'skills'))).toEqual([])
    expect(existsSync(config.CONFIG_PATH)).toBe(false)
})

it('does not overwrite a configuration created while skills were downloading', async () => {
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
        if (String(input).endsWith('assets/example.bin')) {
            writeFileSync(config.CONFIG_PATH, 'user-created configuration')
        }
        return successfulDownload(input)
    })
    await expect(installer.installIfNeeded()).rejects.toThrow('首次安装失败（创建配置文件）')
    expect(readFileSync(config.CONFIG_PATH, 'utf8')).toBe('user-created configuration')
})
