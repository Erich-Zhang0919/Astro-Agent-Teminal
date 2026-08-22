import { loadSkillFn } from './load_skill'
import { discoverSkills, loadSkill } from '../skills'

describe('loadSkillFn', () => {
    let logSpy: jest.SpyInstance

    beforeAll(() => {
        discoverSkills()
    })

    beforeEach(() => {
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(() => {
        logSpy.mockRestore()
    })

    it('returns the full SKILL.md content for a known skill', () => {
        const result = loadSkillFn({ name: 'planner' })
        expect(result).toContain('name: planner')
        expect(result).toBe(loadSkill('planner'))
    })

    it('prints the skill name when called', () => {
        loadSkillFn({ name: 'planner' })
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"planner"'))
    })

    it('returns a friendly error listing available skills for an unknown skill', () => {
        const result = loadSkillFn({ name: 'nope' })
        expect(result).toContain('not found')
        expect(result).toContain('planner')
    })
})
