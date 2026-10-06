import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export interface ProfileUpdateInput {
    profile: string
}

function createBackupFileName(): string {
    const dateTime = new Date().toISOString().replace(/[:.]/g, '-')
    return `profile.${dateTime}-${randomUUID()}.md`
}

export async function profileUpdateFn({ profile }: ProfileUpdateInput): Promise<string> {
    const normalizedProfile = profile.trim()
    if (!normalizedProfile) {
        throw new Error('Profile content cannot be empty.')
    }

    const dataDirectory = path.join(process.cwd(), 'data')
    const profilePath = path.join(dataDirectory, 'profile.md')
    const backupFileName = createBackupFileName()
    const backupPath = path.join(dataDirectory, backupFileName)

    await fs.mkdir(dataDirectory, { recursive: true })

    let backupCreated = false
    try {
        await fs.copyFile(profilePath, backupPath)
        backupCreated = true
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error
        }
    }

    await fs.writeFile(profilePath, `${normalizedProfile}\n`, 'utf-8')

    if (backupCreated) {
        return `Profile updated successfully. Backup created: "data/${backupFileName}"`
    }
    return 'Profile created successfully: "data/profile.md"'
}
