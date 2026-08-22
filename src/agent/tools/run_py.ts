import { exec } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import chalk from 'chalk'

const execAsync = promisify(exec)

// Exported object so tests can override pythonCommand to simulate python3 not found
export const _cfg = { pythonCommand: 'python3' }

async function checkPython(): Promise<string | null> {
    try {
        const { stdout, stderr } = await execAsync(`${_cfg.pythonCommand} --version`)
        // Some Python versions print the version to stderr instead of stdout
        return (stdout.trim() || stderr.trim()) || null
    } catch {
        return null
    }
}

export async function runPyFn({ code }: { code: string }): Promise<string> {
    const pythonVersion = await checkPython()
    if (!pythonVersion) {
        return 'Error: Python 3 is not installed or not found in PATH. Please install Python 3 from https://www.python.org and try again.'
    }

    const tmpFile = path.join(os.tmpdir(), `run_py_${Date.now()}_${Math.random().toString(36).slice(2)}.py`)

    try {
        await fs.writeFile(tmpFile, code, 'utf-8')
        const { stdout, stderr } = await execAsync(`${_cfg.pythonCommand} "${tmpFile}"`, { timeout: 30_000 })
        console.log(chalk.gray(`\n[Tool] run_py called (${pythonVersion})`))
        const parts = [stdout, stderr ? `stderr:\n${stderr}` : ''].filter(Boolean)
        return parts.join('\n') || '(no output)'
    } catch (err: any) {
        const msg: string = err.stderr || err.stdout || err.message || String(err)
        return `Error:\n${msg}`
    } finally {
        await fs.unlink(tmpFile).catch(() => {})
    }
}
