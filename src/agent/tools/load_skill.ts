import chalk from 'chalk'
import { loadSkill, getSkillsListText } from '../skills'

export function loadSkillFn({ name }: { name: string }): string {
    console.log(chalk.magenta(`\n[Skill] load_skill called: "${name}"`))
    const content = loadSkill(name)
    if (content === null) {
        return `Skill "${name}" not found. Available skills:\n${getSkillsListText()}`
    }
    return content
}
