import { loadSkill, getSkillsListText } from '../skills'

export function loadSkillFn({ name }: { name: string }): string {
    const content = loadSkill(name)
    if (content === null) {
        return `Skill "${name}" not found. Available skills:\n${getSkillsListText()}`
    }
    return content
}
