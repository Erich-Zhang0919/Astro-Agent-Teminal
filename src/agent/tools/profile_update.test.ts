import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { profileUpdateFn } from './profile_update'

jest.mock('node:os', () => ({ ...jest.requireActual('node:os'), homedir: jest.fn() }))

describe('profileUpdateFn', () => {
    let temporaryDirectory: string
    let originalCwd: string

    beforeEach(async () => {
        temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-update-test-'))
        jest.mocked(os.homedir).mockReturnValue(path.join(temporaryDirectory, 'home'))
        originalCwd = process.cwd()
        process.chdir(temporaryDirectory)
    })

    afterEach(async () => {
        process.chdir(originalCwd)
        await fs.rm(temporaryDirectory, { recursive: true, force: true })
    })

    it('creates ~/.astro/.data/profile.md independently of the working directory', async () => {
        const result = await profileUpdateFn({ profile: '  - 姓名：小明  ' })

        const dataDirectory = path.join(os.homedir(), '.astro', '.data')
        await expect(fs.readFile(path.join(dataDirectory, 'profile.md'), 'utf-8'))
            .resolves.toBe('- 姓名：小明\n')
        await expect(fs.readdir(dataDirectory))
            .resolves.toEqual(['profile.md'])
        expect(result).toBe(`Profile created successfully: "${path.join(dataDirectory, 'profile.md')}"`)
        await expect(fs.readdir(temporaryDirectory)).resolves.toEqual(['home'])
    })

    it('backs up the existing profile before replacing it with the complete profile', async () => {
        const dataDirectory = path.join(os.homedir(), '.astro', '.data')
        await fs.mkdir(dataDirectory, { recursive: true })
        await fs.writeFile(path.join(dataDirectory, 'profile.md'), '- 姓名：小明\n- 语言：中文\n')

        const result = await profileUpdateFn({
            profile: '- 姓名：小明\n- 语言：中文\n- 工作：工程师',
        })

        const files = await fs.readdir(dataDirectory)
        const backupFile = files.find((file) => /^profile\..+\.md$/.test(file))
        expect(backupFile).toBeDefined()
        await expect(fs.readFile(path.join(dataDirectory, backupFile!), 'utf-8'))
            .resolves.toBe('- 姓名：小明\n- 语言：中文\n')
        await expect(fs.readFile(path.join(dataDirectory, 'profile.md'), 'utf-8'))
            .resolves.toBe('- 姓名：小明\n- 语言：中文\n- 工作：工程师\n')
        expect(result).toContain(path.join(dataDirectory, backupFile!))
    })

    it('rejects empty profile content', async () => {
        await expect(profileUpdateFn({ profile: '  \n\t' }))
            .rejects.toThrow('Profile content cannot be empty.')
    })
})
