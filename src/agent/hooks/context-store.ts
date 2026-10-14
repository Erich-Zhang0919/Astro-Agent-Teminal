import { db } from '../db'
import type { HookInjection } from './engine'

/** An inbox survives session exit and is acknowledged only after graph checkpointing. */
export class HookContextStore {
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
