import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSkillsFn } from './list_skills'
import { discoverSkills, loadSkill } from '../skills'

jest.mock('node:os', () => ({ ...jest.requireActual('node:os'), homedir: jest.fn() }))

let home: string
beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'astro-list-skills-'))
    jest.mocked(homedir).mockReturnValue(home)
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

it('refreshes installed skills and returns the winning source and content after an installation', () => {
    expect(discoverSkills()).toEqual([])
    for (const root of ['.agents/skills', '.astro/skills']) {
        const dir = join(home, root, 'demo')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'SKILL.md'), `---\nname: demo\ndescription: From ${root}\n---\nFull instructions`)
    }
    expect(JSON.parse(listSkillsFn())).toEqual({ count: 1, skills: [{
        name: 'demo', description: 'From .astro/skills', dirPath: join(home, '.astro/skills/demo'),
    }] })
    expect(loadSkill('demo')).toContain('From .astro/skills')
})

it('returns an empty catalog after skills are removed', () => {
    const dir = join(home, '.astro/skills/demo')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: demo\ndescription: Demo\n---\nInstructions')
    expect(JSON.parse(listSkillsFn()).count).toBe(1)
    rmSync(dir, { recursive: true })
    expect(JSON.parse(listSkillsFn())).toEqual({ count: 0, skills: [] })
    expect(loadSkill('demo')).toBeNull()
})
