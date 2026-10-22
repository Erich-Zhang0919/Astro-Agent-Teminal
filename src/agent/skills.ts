import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface SkillInfo {
    name: string
    description: string
    dirPath: string
}

const skills: SkillInfo[] = []
const skillContentMap = new Map<string, string>()

function getSkillDirectories(): string[] {
    const home = homedir()
    return [
        join(home, '.agents', 'skills'),
        join(home, '.astro', '.agents', 'skills'),
        join(home, '.astro', 'skills'),
    ]
}

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

    const discovered = new Map<string, SkillInfo>()
    for (const skillsDir of getSkillDirectories()) {
        let entries: string[]
        try {
            entries = readdirSync(skillsDir)
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code === 'ENOENT' || code === 'ENOTDIR') continue
            throw error
        }
        for (const entry of entries) {
            const entryPath = join(skillsDir, entry)
            try {
                if (!statSync(entryPath).isDirectory()) continue

                const content = readFileSync(join(entryPath, 'SKILL.md'), 'utf-8')
                const { name, description } = parseFrontmatter(content)
                if (name && description) {
                    discovered.set(name, { name, description, dirPath: entryPath })
                    skillContentMap.set(name, content)
                }
            } catch {
                // Ignore directories without SKILL.md or parse errors
            }
        }
    }
    skills.push(...discovered.values())

    return skills
}

export function loadSkill(name: string): string | null {
    return skillContentMap.get(name) ?? null
}

export function getSkillsListText(): string {
    const directories = getSkillDirectories().map(directory => `- ${directory}`).join('\n')
    const newSkillDirectory = join(homedir(), '.astro', 'skills')
    const list = skills.map((s) => `- **${s.name}**: ${s.description}`).join('\n')
    return `${list}\n\nSkills 目录（按顺序加载，同名时后者覆盖前者）:\n${directories}\n新增 skill 必须放在 ${newSkillDirectory} 目录下。`
}
