import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

jest.mock('node:os', () => ({ ...jest.requireActual('node:os'), homedir: jest.fn() }))

let home: string

function loadProfileModules() {
    let modules!: {
        prompt: typeof import('./prompt')
        profileUpdateFn: typeof import('./tools/profile_update').profileUpdateFn
    }
    jest.isolateModules(() => {
        require('node:os').homedir.mockReturnValue(home)
        modules = {
            prompt: require('./prompt'),
            profileUpdateFn: require('./tools/profile_update').profileUpdateFn,
        }
    })
    return modules
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'astro-profile-prompt-'))
})

afterEach(() => {
    rmSync(home, { recursive: true, force: true })
})

describe('buildProfilePrompt', () => {
    it('wraps profile information in profile_info tags', () => {
        const { buildProfilePrompt } = loadProfileModules().prompt
        const prompt = buildProfilePrompt('\n- 姓名：小明\n- 语言：中文\n')

        expect(prompt).toContain('<profile_info>\n- 姓名：小明\n- 语言：中文\n</profile_info>')
    })

    it.each(['', '   \n\t'])('uses empty profile_info tags when profile information is empty', (profileInfo) => {
        const { buildProfilePrompt } = loadProfileModules().prompt
        const prompt = buildProfilePrompt(profileInfo)

        expect(prompt).toContain('<profile_info></profile_info>')
    })
})

describe('systemPrompt profile loading', () => {
    it('uses an empty profile when the user data directory does not exist', () => {
        expect(loadProfileModules().prompt.systemPrompt).toContain('<profile_info></profile_info>')
        expect(existsSync(join(home, '.astro'))).toBe(false)
    })

    it('loads the profile saved by the update tool from the user home directory', async () => {
        await loadProfileModules().profileUpdateFn({ profile: '- 语言：中文' })

        expect(loadProfileModules().prompt.systemPrompt)
            .toContain('<profile_info>\n- 语言：中文\n</profile_info>')
    })
})
