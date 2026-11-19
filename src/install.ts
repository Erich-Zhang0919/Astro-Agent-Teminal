import { existsSync, mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { CONFIG_PATH, WORKSPACE_DIR } from './agent/config'
import chalk from 'chalk'
import { createTerminalProgress } from './terminal-progress'

export const DB_PATH = join(WORKSPACE_DIR, '.data', 'checkpointer.db')

/** Shared by first-run installation and normal startup to retain existing data. */
export function initializeDatabase(): SqliteSaver {
    mkdirSync(dirname(DB_PATH), { recursive: true })
    const checkpointer = SqliteSaver.fromConnString(DB_PATH)
    const db = checkpointer.db
    try {
        // Initialize synchronously before the agent starts handling commands.
        db.exec(`
            CREATE TABLE IF NOT EXISTS memory (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL, -- 'fact' | 'event' | 'preference' | 'skill'
                content TEXT NOT NULL,
                keywords TEXT, -- JSON array
                importance INTEGER DEFAULT 3,
                session_id TEXT, -- LangGraph thread_id
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
                content,
                keywords,
                content='memory',
                content_rowid='id'
            );
        `)

        const memoryFtsTriggersExist = db.prepare(`
            SELECT COUNT(*) AS count
            FROM sqlite_master
            WHERE type = 'trigger'
              AND name IN ('memory_ai', 'memory_ad', 'memory_au')
        `).get() as { count: number }

        db.exec(`
            CREATE TRIGGER IF NOT EXISTS memory_ai
            AFTER INSERT ON memory
            BEGIN
                INSERT INTO memory_fts(rowid, content, keywords)
                VALUES (new.id, new.content, new.keywords);
            END;

            CREATE TRIGGER IF NOT EXISTS memory_ad
            AFTER DELETE ON memory
            BEGIN
                INSERT INTO memory_fts(memory_fts, rowid, content, keywords)
                VALUES ('delete', old.id, old.content, old.keywords);
            END;

            CREATE TRIGGER IF NOT EXISTS memory_au
            AFTER UPDATE OF content, keywords ON memory
            BEGIN
                INSERT INTO memory_fts(memory_fts, rowid, content, keywords)
                VALUES ('delete', old.id, old.content, old.keywords);

                INSERT INTO memory_fts(rowid, content, keywords)
                VALUES (new.id, new.content, new.keywords);
            END;
        `)

        // Creating sync triggers does not index rows that already exist in memory.
        if (memoryFtsTriggersExist.count < 3) {
            db.exec(`INSERT INTO memory_fts(memory_fts) VALUES ('rebuild')`)
        }
        return checkpointer
    } catch (error) {
        db.close()
        throw error
    }
}

const DEFAULT_SKILLS = [
    { name: 'find-skills', repository: 'vercel-labs/skills' },
    { name: 'skill-creator', repository: 'anthropics/skills' },
] as const

interface GitHubTreeEntry {
    path: string
    type: string
    mode: string
}

async function download(url: string): Promise<Response> {
    const response = await fetch(url, {
        headers: { 'User-Agent': 'astro-installer' },
        signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}: ${url}`)
    return response
}

async function installSkill(
    skill: typeof DEFAULT_SKILLS[number],
    progress: ReturnType<typeof createTerminalProgress>,
): Promise<void> {
    const skillsDirectory = join(WORKSPACE_DIR, '.agents', 'skills')
    const destination = join(skillsDirectory, skill.name)
    if (existsSync(destination)) {
        // A previous attempt may already have installed this skill successfully.
        await readFile(join(destination, 'SKILL.md'), 'utf8')
        progress.note(chalk.dim(`  📦 ${skill.name} 已存在，保留现有内容`))
        return
    }

    progress.update(`🧩 [2/3] 正在下载 ${skill.name}（${skill.repository}）…`)
    const response = await download(
        `https://api.github.com/repos/${skill.repository}/git/trees/main?recursive=1`,
    )
    const tree = await response.json() as { truncated?: boolean; tree?: GitHubTreeEntry[] }
    if (tree.truncated || !Array.isArray(tree.tree)) {
        throw new Error(`无法取得 ${skill.name} 的完整目录`)
    }
    const prefix = `skills/${skill.name}/`
    const files = tree.tree.filter(entry => entry.type === 'blob' && entry.path.startsWith(prefix))
    if (!files.some(entry => entry.path === `${prefix}SKILL.md`)) {
        throw new Error(`${skill.name} 的源目录缺少 SKILL.md`)
    }

    await mkdir(skillsDirectory, { recursive: true })
    const staging = await mkdtemp(join(skillsDirectory, `.${skill.name}-`))
    try {
        for (const [index, file] of files.entries()) {
            const relativePath = file.path.slice(prefix.length)
            const segments = relativePath.split('/')
            if (file.mode === '120000' || segments.some(segment =>
                !segment || segment === '.' || segment === '..' || /[\\:]/u.test(segment))) {
                throw new Error(`${skill.name} 包含不支持的路径：${relativePath}`)
            }
            progress.update(`🧩 [2/3] ${skill.name} (${index + 1}/${files.length}) ${relativePath}`)
            const content = await download(
                `https://raw.githubusercontent.com/${skill.repository}/main/${file.path}`,
            )
            const target = join(staging, ...segments)
            await mkdir(dirname(target), { recursive: true })
            await writeFile(target, Buffer.from(await content.arrayBuffer()), {
                mode: file.mode === '100755' ? 0o755 : 0o644,
            })
        }
        await rename(staging, destination)
        progress.note(`  📦 ${skill.name} 安装完成 ${chalk.dim(`(${files.length} 个文件)`)}`)
    } finally {
        await rm(staging, { recursive: true, force: true })
    }
}

/** Returns true when installation ran; the user must configure Astro and restart. */
export async function installIfNeeded(): Promise<boolean> {
    if (existsSync(CONFIG_PATH)) return false

    console.log(chalk.bold.cyan('\n🚀 欢迎使用 Astro，你的 AI 工作伙伴！'))
    console.log(chalk.dim('✨ 初次见面，先为你准备好工作空间。\n'))
    const progress = createTerminalProgress()
    let step = '初始化数据库'
    try {
        progress.start('🗄️  [1/3] 正在初始化数据库…')
        const checkpointer = initializeDatabase()
        try {
            // Initialize LangGraph's checkpoint tables without creating a session.
            await checkpointer.getTuple({ configurable: { thread_id: '__install__' } })
        } finally {
            checkpointer.db.close()
        }
        progress.succeed('[1/3] 数据库初始化完成')

        step = '安装 skills'
        progress.start('🧩 [2/3] 正在安装默认 skills…')
        for (const skill of DEFAULT_SKILLS) await installSkill(skill, progress)
        progress.succeed('[2/3] 默认 skills 安装完成')

        step = '创建配置文件'
        progress.start('⚙️  [3/3] 正在创建配置文件…')
        await writeFile(CONFIG_PATH, JSON.stringify({
            model: { model: 'kimi-k2.6', apiKey: '', baseURL: 'https://api.moonshot.cn/v1' },
            env: { TAVILY_API_KEY: '' },
        }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
        progress.succeed('[3/3] 配置文件创建完成')
        console.log(chalk.bold.green('\n🎉 工作空间已准备好，再完成一点配置就能开始！'))
        console.log(`\n📝 请编辑配置文件：${chalk.cyan(CONFIG_PATH)}`)
        console.log('   填写 model 中的模型名称、API Key、baseURL，以及 env.TAVILY_API_KEY。')
        console.log(`📖 配置参考：${chalk.cyan('https://zhitalk.chat/#config')}`)
        console.log(`💬 保存配置后，请重新运行 ${chalk.bold('astro chat')}（或原命令）。\n`)
        return true
    } catch (error) {
        progress.fail(`${step}未完成`)
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`首次安装失败（${step}）：${message}。请修复后重新运行 astro，安装将自动重试。`)
    }
}
