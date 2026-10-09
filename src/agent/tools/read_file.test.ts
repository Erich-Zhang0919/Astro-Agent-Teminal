import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { readFileFn } from './read_file'

describe('readFileFn', () => {
    let tmpDir: string
    let outsideFile: string
    let originalCwd: string

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-file-test-'))
        outsideFile = `${tmpDir}.outside.txt`
        originalCwd = process.cwd()
        process.chdir(tmpDir)
    })

    afterEach(async () => {
        process.chdir(originalCwd)
        await fs.rm(tmpDir, { recursive: true, force: true })
        await fs.rm(outsideFile, { force: true })
    })

    it('reads a file in the current directory', async () => {
        await fs.writeFile(path.join(tmpDir, 'hello.txt'), 'hello world')
        const result = await readFileFn({ file_path: 'hello.txt' })
        expect(result).toBe('hello world')
    })

    it('reads a file in a subdirectory', async () => {
        await fs.mkdir(path.join(tmpDir, 'sub'))
        await fs.writeFile(path.join(tmpDir, 'sub', 'data.txt'), 'nested content')
        const result = await readFileFn({ file_path: 'sub/data.txt' })
        expect(result).toBe('nested content')
    })

    it('reads a relative path outside cwd', async () => {
        await fs.writeFile(outsideFile, 'outside content')
        const result = await readFileFn({ file_path: path.relative(tmpDir, outsideFile) })
        expect(result).toBe('outside content')
    })

    it('reads an absolute path outside cwd', async () => {
        await fs.writeFile(outsideFile, 'absolute content')
        const result = await readFileFn({ file_path: outsideFile })
        expect(result).toBe('absolute content')
    })

    it('throws a clear error for a missing file, including cwd in message', async () => {
        await expect(readFileFn({ file_path: 'nonexistent.txt' })).rejects.toThrow(
            /File not found:.*nonexistent\.txt.*cwd:/,
        )
    })
})
