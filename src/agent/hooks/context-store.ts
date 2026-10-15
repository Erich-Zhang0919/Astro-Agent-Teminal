import { db } from '../db'
import type { HookInjection } from './engine'

export interface HookInbox {
    append(threadId: string, injections: HookInjection[]): void
    get(threadId: string): HookInjection[]
    acknowledge(threadId: string, messageIds: string[]): void
}

/** Child session context never enters the durable lifecycle inbox. */
export class MemoryHookContextStore implements HookInbox {
    private readonly messages = new Map<string, HookInjection[]>()

    append(threadId: string, injections: HookInjection[]): void {
        const existing = this.get(threadId)
        const ids = new Set(existing.map(message => message.id))
        for (const injection of injections) {
            if (!ids.has(injection.id)) {
                existing.push(injection)
                ids.add(injection.id)
            }
        }
        this.messages.set(threadId, existing)
    }

    get(threadId: string): HookInjection[] {
        return [...this.messages.get(threadId) ?? []]
    }

    acknowledge(threadId: string, messageIds: string[]): void {
        const ids = new Set(messageIds)
        const remaining = this.get(threadId).filter(message => !ids.has(message.id))
        if (remaining.length) this.messages.set(threadId, remaining)
        else this.messages.delete(threadId)
    }

    clear(): void {
        this.messages.clear()
    }
}

/** An inbox survives session exit and is acknowledged only after graph checkpointing. */
export class HookContextStore implements HookInbox {
    constructor(private readonly database = db) {
        database.exec(`
            CREATE TABLE IF NOT EXISTS hook_context (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                event TEXT NOT NULL,
                text TEXT NOT NULL
            );
        `)
    }

    append(threadId: string, injections: HookInjection[]): void {
        const insert = this.database.prepare(
            'INSERT OR IGNORE INTO hook_context (id, session_id, event, text) VALUES (?, ?, ?, ?)',
        )
        this.database.transaction(() => {
            for (const injection of injections) {
                insert.run(injection.id, threadId, injection.event, injection.text)
            }
        })()
    }

    get(threadId: string): HookInjection[] {
        return this.database.prepare(
            'SELECT id, event, text FROM hook_context WHERE session_id = ? ORDER BY rowid',
        ).all(threadId) as HookInjection[]
    }

    acknowledge(threadId: string, messageIds: string[]): void {
        const remove = this.database.prepare('DELETE FROM hook_context WHERE session_id = ? AND id = ?')
        this.database.transaction(() => {
            for (const id of messageIds) remove.run(threadId, id)
        })()
    }
}
