import { homedir } from 'node:os'
import { join } from 'node:path'

export function getProfilePath(): string {
    return join(homedir(), '.astro', '.data', 'profile.md')
}
