import * as fs from 'fs/promises'
import * as path from 'path'
import chalk from 'chalk'

export async function writeFileFn({
    file_path,
    content,
}: {
    file_path: string
    content: string
}): Promise<string> {
    const cwd = process.cwd()
    const resolved = path.resolve(cwd, file_path)

    if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
        throw new Error(`Access denied: path must be within the current directory (${cwd})`)
    }

    const dir = path.dirname(resolved)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(resolved, content, 'utf-8')

    console.log(chalk.gray(`\n[Tool] write_file called: "${file_path}"`))
    return `File written successfully: "${file_path}"`
}
