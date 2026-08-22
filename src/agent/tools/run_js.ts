import { exec } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import chalk from 'chalk'

const execAsync = promisify(exec)

// Exported object so tests can override nodeCommand to simulate node not found
export const _cfg = { nodeCommand: 'node' }

async function checkNode(): Promise<string | null> {
    try {
        const { stdout } = await execAsync(`${_cfg.nodeCommand} --version`)
        return stdout.trim()
    } catch {
        return null
    }
}

export async function runJsFn({ code }: { code: string }): Promise<string> {
    const nodeVersion = await checkNode()
    if (!nodeVersion) {
        return 'Error: Node.js is not installed or not found in PATH. Please install Node.js from https://nodejs.org and try again.'
    }

    const tmpFile = path.join(os.tmpdir(), `run_js_${Date.now()}_${Math.random().toString(36).slice(2)}.js`)

    try {
        await fs.writeFile(tmpFile, code, 'utf-8')
        const { stdout, stderr } = await execAsync(`${_cfg.nodeCommand} "${tmpFile}"`, { timeout: 30_000 })
        console.log(chalk.gray(`\n[Tool] run_js called (${nodeVersion})`))
        const parts = [stdout, stderr ? `stderr:\n${stderr}` : ''].filter(Boolean)
        return parts.join('\n') || '(no output)'
    } catch (err: any) {
        const msg: string = err.stderr || err.stdout || err.message || String(err)
        return `Error:\n${msg}`
    } finally {
        await fs.unlink(tmpFile).catch(() => {})
    }
}
