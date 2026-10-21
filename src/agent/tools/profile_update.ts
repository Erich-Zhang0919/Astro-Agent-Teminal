import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { getProfilePath } from '../profile-path'

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

    const profilePath = getProfilePath()
    const dataDirectory = path.dirname(profilePath)
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
        return `Profile updated successfully. Backup created: "${backupPath}"`
    }
    return `Profile created successfully: "${profilePath}"`
}
