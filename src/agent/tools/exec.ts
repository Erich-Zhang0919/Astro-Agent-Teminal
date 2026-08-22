import { exec } from 'child_process'
import { promisify } from 'util'
import chalk from 'chalk'

const execAsync = promisify(exec)

// Commands that can cause irreversible damage (file deletion, privilege escalation, system control)
const BLOCKED_PATTERNS: RegExp[] = [
    /\brm\b/,
    /\brmdir\b/,
    /\bsudo\b/,
    /\bchmod\b/,
    /\bchown\b/,
    /\bshutdown\b/,
    /\breboot\b/,
    /\bhalt\b/,
    /\bpoweroff\b/,
    /\bmkfs\b/,
    /\bfdisk\b/,
    /\bdd\b/,
    /\bkill\b/,
    /\bpkill\b/,
    /\bkillall\b/,
    /\bshred\b/,
    /\bunlink\b/,
]

export async function execFn({ command }: { command: string }): Promise<string> {
    const cwd = process.cwd()

    for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(command)) {
            throw new Error(`Blocked: command contains a prohibited operation (matched /${pattern.source}/)`)
        }
    }

    try {
        const { stdout, stderr } = await execAsync(command, { cwd, timeout: 30_000 })
        console.log(chalk.gray(`\n[Tool] exec called: "${command}"`))
        const parts = [stdout, stderr ? `stderr:\n${stderr}` : ''].filter(Boolean)
        return parts.join('\n') || '(no output)'
    } catch (err: any) {
        throw new Error(`Command failed: ${err.message}`)
    }
}
