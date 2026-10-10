import { exec } from 'child_process'
import { promisify } from 'util'
import { decideExecPermission } from '../permission/exec'

const execAsync = promisify(exec)

export async function execFn({ command }: { command: string }): Promise<string> {
    const cwd = process.cwd()
    const permission = decideExecPermission({ command }, cwd)
    if (permission.kind === 'block') throw new Error(permission.message)

    try {
        const { stdout, stderr } = await execAsync(command, { cwd, timeout: 30_000 })
        const parts = [stdout, stderr ? `stderr:\n${stderr}` : ''].filter(Boolean)
        return parts.join('\n') || '(no output)'
    } catch (err: any) {
        throw new Error(`Command failed: ${err.message}`)
    }
}
