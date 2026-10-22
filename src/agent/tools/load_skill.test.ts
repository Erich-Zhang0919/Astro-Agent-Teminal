import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSkillFn } from './load_skill'
import { discoverSkills, getSkillsListText, loadSkill } from '../skills'

jest.mock('node:os', () => ({ ...jest.requireActual('node:os'), homedir: jest.fn() }))

let home: string
let directories: string[]

function writeSkill(index: number, folder: string, name: string, description: string): string {
    const directory = join(directories[index], folder)
    mkdirSync(directory, { recursive: true })
    const content = `---\nname: ${name}\ndescription: ${description}\n---\n${description}\n`
    writeFileSync(join(directory, 'SKILL.md'), content)
    return content
}

describe('loadSkillFn', () => {
    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 'astro-skills-'))
        jest.mocked(homedir).mockReturnValue(home)
        directories = [
            join(home, '.agents', 'skills'),
            join(home, '.astro', '.agents', 'skills'),
            join(home, '.astro', 'skills'),
        ]
        writeSkill(0, 'planner', 'planner', 'Plan a task')
        discoverSkills()
    })

    afterEach(() => rmSync(home, { recursive: true, force: true }))

    it('returns the full SKILL.md content for a known skill', () => {
        const result = loadSkillFn({ name: 'planner' })
        expect(result).toContain('name: planner')
        expect(result).toBe(loadSkill('planner'))
    })

    it('returns a friendly error listing available skills for an unknown skill', () => {
        const result = loadSkillFn({ name: 'nope' })
        expect(result).toContain('not found')
        expect(result).toContain('planner')
    })

    it.each([1, 2])('lets directory %i override earlier skills by name, including their paths and content', index => {
        let expectedContent = ''
        for (let current = 0; current <= index; current++) {
            expectedContent = writeSkill(current, `variant-${current}`, 'planner', `Version ${current}`)
            writeSkill(current, `unique-${current}`, `unique-${current}`, `Unique ${current}`)
        }
        const skills = discoverSkills()

        expect(skills.filter(skill => skill.name === 'planner')).toEqual([{
            name: 'planner', description: `Version ${index}`,
            dirPath: join(directories[index], `variant-${index}`),
        }])
        expect(loadSkillFn({ name: 'planner' })).toBe(expectedContent)
        for (let current = 0; current <= index; current++) {
            expect(skills.some(skill => skill.name === `unique-${current}`)).toBe(true)
        }
        expect(getSkillsListText().match(/\*\*planner\*\*/g)).toHaveLength(1)
    })

    it('returns no skills and clears previously loaded content when all directories are missing', () => {
        rmSync(join(home, '.agents'), { recursive: true })

        expect(discoverSkills()).toEqual([])
        expect(loadSkill('planner')).toBeNull()
    })

    it('loads a later directory when the earlier directories are missing', () => {
        rmSync(join(home, '.agents'), { recursive: true })
        const content = writeSkill(2, 'last', 'last', 'Last directory only')

        expect(discoverSkills()).toEqual([{
            name: 'last', description: 'Last directory only', dirPath: join(directories[2], 'last'),
        }])
        expect(loadSkill('last')).toBe(content)
    })

    it('keeps a valid earlier skill when a later entry has no valid SKILL.md', () => {
        const original = loadSkill('planner')
        mkdirSync(join(directories[2], 'empty'), { recursive: true })
        writeFileSync(join(directories[2], 'plain-file'), 'ignored')
        writeSkill(2, 'invalid', 'planner', '')

        expect(discoverSkills().filter(skill => skill.name === 'planner')).toHaveLength(1)
        expect(loadSkill('planner')).toBe(original)
    })

    it('lists all three home directories in priority order', () => {
        const text = getSkillsListText()
        expect(text).toContain(directories.join('\n- '))
        expect(text).toContain('同名时后者覆盖前者')
    })
})
