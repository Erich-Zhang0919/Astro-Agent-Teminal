import * as fs from 'fs/promises'
import * as path from 'path'

export async function writeFileFn({
    file_path,
    content,
}: {
    file_path: string
    content: string
}): Promise<string> {
    const cwd = process.cwd()
    const resolved = path.resolve(cwd, file_path)

    const dir = path.dirname(resolved)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(resolved, content, 'utf-8')

    return `File written successfully: "${file_path}"`
}
