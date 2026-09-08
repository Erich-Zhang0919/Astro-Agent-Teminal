import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ContextCompactionRecord } from './context-usage'

interface StoredContextCompaction {
    version: 1
    threadId: string
    record: ContextCompactionRecord
}

export class ContextCompactionStore {
    constructor(
        readonly directory = resolve(process.cwd(), '.data', 'context-compactions'),
    ) {}

    async get(threadId: string): Promise<ContextCompactionRecord | undefined> {
        if (!threadId) return undefined

        try {
            const value = JSON.parse(await readFile(this.getPath(threadId), 'utf8')) as unknown
            return isStoredContextCompaction(value, threadId) ? value.record : undefined
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code === 'ENOENT' || error instanceof SyntaxError) return undefined
            throw error
        }
    }

    async set(threadId: string, record: ContextCompactionRecord): Promise<void> {
        if (!threadId) throw new Error('A thread ID is required to cache context compaction.')

        await mkdir(this.directory, { recursive: true })
        const targetPath = this.getPath(threadId)
        const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
        const value: StoredContextCompaction = { version: 1, threadId, record }

        try {
            await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
            await rename(temporaryPath, targetPath)
        } catch (error) {
            await unlink(temporaryPath).catch(() => undefined)
            throw error
        }
    }

    async delete(threadId: string): Promise<void> {
        if (!threadId) return
        await unlink(this.getPath(threadId)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
        })
    }

    private getPath(threadId: string): string {
        const key = createHash('sha256').update(threadId).digest('hex')
        return resolve(this.directory, `${key}.json`)
    }
}

function isStoredContextCompaction(
    value: unknown,
    threadId: string,
): value is StoredContextCompaction {
    if (!value || typeof value !== 'object') return false

    const stored = value as Partial<StoredContextCompaction>
    const record = stored.record as Partial<ContextCompactionRecord> | undefined
    return stored.version === 1 &&
        stored.threadId === threadId &&
        record !== undefined &&
        typeof record.summary === 'string' &&
        record.summary.length > 0 &&
        Number.isInteger(record.compactedMessageCount) &&
        (record.compactedMessageCount as number) > 0 &&
        typeof record.compactedPrefixFingerprint === 'string' &&
        /^[a-f0-9]{64}$/u.test(record.compactedPrefixFingerprint) &&
        Number.isInteger(record.compactionCount) &&
        (record.compactionCount as number) > 0 &&
        typeof record.updatedAt === 'string' &&
        !Number.isNaN(Date.parse(record.updatedAt))
}
