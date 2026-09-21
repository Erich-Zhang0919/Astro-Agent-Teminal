import { db } from '../db'

export interface MemoryDeleteInput {
    id: number
}

export async function memoryDeleteFn({ id }: MemoryDeleteInput): Promise<string> {
    // memory_ad removes the corresponding memory_fts entry in the same statement.
    const result = db.prepare(`
        DELETE FROM memory
        WHERE id = ?
    `).run(id)

    if (result.changes === 0) {
        return `Memory not found: id=${id}`
    }

    return `Memory deleted successfully: id=${id}`
}
