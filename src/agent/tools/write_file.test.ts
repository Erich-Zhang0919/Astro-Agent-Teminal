import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { writeFileFn } from './write_file'

describe('writeFileFn', () => {
    let tmpDir: string
    let originalCwd: string

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'write-file-test-'))
        originalCwd = process.cwd()
        process.chdir(tmpDir)
    })

    afterEach(async () => {
        process.chdir(originalCwd)
        await fs.rm(tmpDir, { recursive: true, force: true })
    })

    it('creates a new file in the current directory', async () => {
        await writeFileFn({ file_path: 'output.txt', content: 'hello world' })
        const result = await fs.readFile(path.join(tmpDir, 'output.txt'), 'utf-8')
        expect(result).toBe('hello world')
    })

    it('overwrites an existing file', async () => {
        await fs.writeFile(path.join(tmpDir, 'existing.txt'), 'old content')
        await writeFileFn({ file_path: 'existing.txt', content: 'new content' })
        const result = await fs.readFile(path.join(tmpDir, 'existing.txt'), 'utf-8')
        expect(result).toBe('new content')
    })

    it('creates parent directories as needed', async () => {
        await writeFileFn({ file_path: 'sub/dir/file.txt', content: 'nested' })
        const result = await fs.readFile(path.join(tmpDir, 'sub/dir/file.txt'), 'utf-8')
        expect(result).toBe('nested')
    })

    it('returns a success message', async () => {
        const result = await writeFileFn({ file_path: 'out.txt', content: 'data' })
        expect(result).toMatch(/File written successfully/)
    })

    it('throws when path traverses outside cwd', async () => {
        await expect(
            writeFileFn({ file_path: '../escape.txt', content: 'bad' }),
        ).rejects.toThrow('Access denied')
    })

    it('throws when path uses absolute location outside cwd', async () => {
        await expect(
            writeFileFn({ file_path: '/tmp/escape.txt', content: 'bad' }),
        ).rejects.toThrow('Access denied')
    })
})
