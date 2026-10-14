import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { HookContextStore } from './context-store'

jest.mock('../db', () => ({ db: undefined }))

it('persists an ordered inbox across reopening and acknowledges only the selected thread', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'astro-hook-context-'))
    const path = join(directory, 'hooks.db')
    let database = SqliteSaver.fromConnString(path).db
    try {
        const store = new HookContextStore(database)
        const start = { id: 'start', event: 'SessionStart' as const, text: 'start context' }
        const end = { id: 'end', event: 'SessionEnd' as const, text: 'end context' }
        store.append('thread', [start, end])
        store.append('thread', [start])
        store.append('other', [{ ...end, id: 'other-end' }])
        database.close()
        database = SqliteSaver.fromConnString(path).db
        const restored = new HookContextStore(database)
        expect(restored.get('thread')).toEqual([start, end])
        restored.acknowledge('other', ['start'])
        expect(restored.get('thread')).toEqual([start, end])
        restored.acknowledge('thread', ['start'])
        expect(restored.get('thread')).toEqual([end])
        expect(restored.get('other')).toHaveLength(1)
    } finally {
        database.close()
        await rm(directory, { recursive: true, force: true })
    }
})
