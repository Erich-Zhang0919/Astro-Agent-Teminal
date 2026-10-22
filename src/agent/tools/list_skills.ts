import { discoverSkills } from '../skills'

/** Refresh the framework's catalog without shell commands or arbitrary paths. */
export function listSkillsFn(): string {
    const skills = discoverSkills()
    return JSON.stringify({ count: skills.length, skills })
}
