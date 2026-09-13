import * as fs from 'fs/promises'
import * as path from 'path'

export async function readFileFn({ file_path }: { file_path: string }): Promise<string> {
    const cwd = process.cwd()
    const resolved = path.resolve(cwd, file_path)

    // Reject any path that escapes the current working directory
    if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
        throw new Error(`Access denied: path must be within the current directory (${cwd})`)
    }

    try {
        const content = await fs.readFile(resolved, 'utf-8')
        return content
    } catch (err: any) {
        if (err.code === 'ENOENT') {
            throw new Error(
                `File not found: "${file_path}" (resolved to: ${resolved}, cwd: ${cwd})`,
            )
        }
        throw err
    }
}
