import { cpSync, readdirSync, statSync, mkdirSync } from 'fs'
import { join, dirname, relative } from 'path'
import { fileURLToPath } from 'url'

const root = dirname(fileURLToPath(import.meta.url)) + '/..'
const srcDir = join(root, 'src/agent/skills')
const outDir = join(root, 'dist/agent/skills')

function copyMarkdown(dir) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) {
            copyMarkdown(full)
        } else if (entry.endsWith('.md')) {
            const dest = join(outDir, relative(srcDir, full))
            mkdirSync(dirname(dest), { recursive: true })
            cpSync(full, dest)
            console.log(`copied ${relative(root, full)} -> ${relative(root, dest)}`)
        }
    }
}

copyMarkdown(srcDir)
