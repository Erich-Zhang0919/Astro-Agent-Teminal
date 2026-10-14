import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { HookEngine } from './engine'

const cwd = resolve(__dirname, '../../..')
let directory: string
let engine: HookEngine

beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'protect-env-'))
    await writeFile(join(directory, '.env'), 'TEST_SECRET=fixture')
    await writeFile(join(directory, 'notes.txt'), 'ordinary file')
    await symlink(join(directory, '.env'), join(directory, 'linked.txt'))
    engine = await HookEngine.load({ cwd, hooksPath: 'src/agent/hooks/hooks.json' })
})

afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
})

async function check(filePath: unknown) {
    return engine.run({
        version: 1, event: 'PreToolUse', eventId: 'protect-env-test',
        sessionId: 'protect-env-session', cwd,
        tool: { name: 'read_file', args: { file_path: filePath } },
    })
}

it('blocks absolute, relative and normalized .env paths', async () => {
    for (const filePath of [
        '.env', './.env', 'nested/../.env', 'nested/.env',
        join(directory, '.env'), relative(cwd, join(directory, '.env')),
    ]) {
        await expect(check(filePath)).resolves.toMatchObject({
            blocked: true, error: expect.stringContaining('Reading .env files is blocked'),
        })
    }
})

it('blocks a symbolic link to .env without exposing its contents', async () => {
    const result = await check(join(directory, 'linked.txt'))
    expect(result.blocked).toBe(true)
    expect(result.error).toContain('Reading .env files is blocked')
    expect(result.error).not.toContain('TEST_SECRET')
})

it('allows ordinary files and lets read_file handle missing files', async () => {
    for (const filePath of [join(directory, 'notes.txt'), 'missing.txt', 'my.env']) {
        await expect(check(filePath)).resolves.toEqual({ blocked: false, injections: [] })
    }
})

it.each([undefined, null, 42, ''])('blocks invalid file_path input: %p', async filePath => {
    await expect(check(filePath)).resolves.toMatchObject({ blocked: true })
})
