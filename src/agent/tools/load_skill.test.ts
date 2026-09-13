import { loadSkillFn } from './load_skill'
import { discoverSkills, loadSkill } from '../skills'

describe('loadSkillFn', () => {
    beforeAll(() => {
        discoverSkills()
    })

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
})
