import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { writeFileFn } from './write_file'

describe('writeFileFn', () => {
    let tmpDir: string
    let outsideFile: string
    let originalCwd: string

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'write-file-test-'))
        outsideFile = `${tmpDir}.outside.txt`
        originalCwd = process.cwd()
        process.chdir(tmpDir)
    })

    afterEach(async () => {
        process.chdir(originalCwd)
        await fs.rm(tmpDir, { recursive: true, force: true })
        await fs.rm(outsideFile, { force: true })
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

    it('writes a relative path outside cwd', async () => {
        await writeFileFn({ file_path: path.relative(tmpDir, outsideFile), content: 'relative' })
        expect(await fs.readFile(outsideFile, 'utf-8')).toBe('relative')
    })

    it('writes an absolute path outside cwd', async () => {
        await writeFileFn({ file_path: outsideFile, content: 'absolute' })
        expect(await fs.readFile(outsideFile, 'utf-8')).toBe('absolute')
    })
})
