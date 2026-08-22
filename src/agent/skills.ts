import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

export interface SkillInfo {
    name: string
    description: string
    dirPath: string
}

const skills: SkillInfo[] = []
const skillContentMap = new Map<string, string>()

function parseFrontmatter(content: string): { name: string; description: string } {
    if (!content.startsWith('---')) {
        return { name: '', description: '' }
    }
    const endIdx = content.indexOf('---', 3)
    if (endIdx === -1) {
        return { name: '', description: '' }
    }
    const frontmatter = content.slice(3, endIdx).trim()
    const lines = frontmatter.split('\n')
    const result: Record<string, string> = {}
    for (const line of lines) {
        const colonIdx = line.indexOf(':')
        if (colonIdx === -1) continue
        const key = line.slice(0, colonIdx).trim()
        const value = line.slice(colonIdx + 1).trim()
        result[key] = value
    }
    return { name: result.name || '', description: result.description || '' }
}

export function discoverSkills(): SkillInfo[] {
    skills.length = 0
    skillContentMap.clear()

    const skillsDir = join(__dirname, 'skills')
    const entries = readdirSync(skillsDir)
    for (const entry of entries) {
        const entryPath = join(skillsDir, entry)
        try {
            const entryStat = statSync(entryPath)
            if (!entryStat.isDirectory()) continue

            const skillMdPath = join(entryPath, 'SKILL.md')
            const content = readFileSync(skillMdPath, 'utf-8')
            const { name, description } = parseFrontmatter(content)
            if (name && description) {
                skills.push({ name, description, dirPath: entryPath })
                skillContentMap.set(name, content)
            }
        } catch {
            // Ignore directories without SKILL.md or parse errors
        }
    }

    return skills
}

export function loadSkill(name: string): string | null {
    return skillContentMap.get(name) ?? null
}

export function getSkillsListText(): string {
    const skillsDir = join(__dirname, 'skills')
    const list = skills.map((s) => `- **${s.name}**: ${s.description}`).join('\n')
    return `${list}\n\nSkills 目录: ${skillsDir}\n如需新增 skill，请将其放置在该目录下。`
}