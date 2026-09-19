import type { RunnableConfig } from '@langchain/core/runnables'
import { db } from '../db'

export interface MemoryCreateInput {
    type: 'fact' | 'event' | 'preference' | 'skill'
    content: string
    keywords?: string[]
    importance?: number
}

export async function memoryCreateFn({
    type,
    content,
    keywords = [],
    importance = 3,
}: MemoryCreateInput, config?: RunnableConfig): Promise<string> {
    const sessionId = config?.configurable?.thread_id
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
        throw new Error('Cannot create memory without a valid thread_id.')
    }

    const result = db.prepare(`
        INSERT INTO memory (type, content, keywords, importance, session_id)
        VALUES (?, ?, ?, ?, ?)
    `).run(type, content, JSON.stringify(keywords), importance, sessionId)

    return `Memory created successfully: id=${result.lastInsertRowid}`
}
