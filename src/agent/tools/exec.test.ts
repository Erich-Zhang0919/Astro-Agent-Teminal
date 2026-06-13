import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { execFn } from './exec'

describe('execFn', () => {
    let tmpDir: string
    let originalCwd: string

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exec-tool-test-'))
        originalCwd = process.cwd()
        process.chdir(tmpDir)
    })

    afterEach(async () => {
        process.chdir(originalCwd)
        await fs.rm(tmpDir, { recursive: true, force: true })
    })

    it('runs a simple command and returns stdout', async () => {
        const result = await execFn({ command: 'echo hello' })
        expect(result.trim()).toBe('hello')
    })

    it('runs command inside the current working directory', async () => {
        await fs.writeFile(path.join(tmpDir, 'marker.txt'), '')
        const result = await execFn({ command: 'ls' })
        expect(result).toContain('marker.txt')
    })

    it('returns (no output) when command produces nothing', async () => {
        const result = await execFn({ command: 'true' })
        expect(result).toBe('(no output)')
    })

    it('throws on non-zero exit', async () => {
        await expect(execFn({ command: 'nonexistent_command_xyz_abc' })).rejects.toThrow('Command failed')
    })

    it('blocks rm', async () => {
        await expect(execFn({ command: 'rm -rf .' })).rejects.toThrow('Blocked')
    })

    it('blocks rmdir', async () => {
        await expect(execFn({ command: 'rmdir somedir' })).rejects.toThrow('Blocked')
    })

    it('blocks sudo', async () => {
        await expect(execFn({ command: 'sudo ls' })).rejects.toThrow('Blocked')
    })

    it('blocks kill', async () => {
        await expect(execFn({ command: 'kill -9 1' })).rejects.toThrow('Blocked')
    })

    it('blocks shutdown', async () => {
        await expect(execFn({ command: 'shutdown -h now' })).rejects.toThrow('Blocked')
    })

    it('blocks dd', async () => {
        await expect(execFn({ command: 'dd if=/dev/zero of=file bs=1M count=1' })).rejects.toThrow('Blocked')
    })

    it('blocks shred', async () => {
        await expect(execFn({ command: 'shred file.txt' })).rejects.toThrow('Blocked')
    })
})
