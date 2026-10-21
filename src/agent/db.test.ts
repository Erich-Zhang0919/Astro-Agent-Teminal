import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

jest.mock('node:os', () => ({ ...jest.requireActual('node:os'), homedir: jest.fn() }))
jest.mock('uuid', () => ({ v5: jest.fn(), v6: jest.fn() }), { virtual: true })

let home: string
let database: typeof import('./db') | undefined

function startDatabase(): typeof import('./db') {
    jest.isolateModules(() => {
        require('node:os').homedir.mockReturnValue(home)
        database = require('./db')
    })
    return database!
}

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'astro-db-'))
})

afterEach(() => {
    if (database?.db.open) database.db.close()
    database = undefined
    rmSync(home, { recursive: true, force: true })
})

it('creates the missing user data directory and a usable database on startup', () => {
    const directory = join(home, '.astro', '.data')
    expect(existsSync(directory)).toBe(false)

    const { DB_PATH, db, checkpointer } = startDatabase()
    expect(DB_PATH).toBe(join(directory, 'checkpointer.db'))
    expect(existsSync(DB_PATH)).toBe(true)
    expect(db).toBe(checkpointer.db)
    db.prepare('INSERT INTO memory(type, content, keywords) VALUES (?, ?, ?)')
        .run('fact', 'startup fixture', 'startup')
    expect(db.prepare("SELECT content FROM memory_fts WHERE memory_fts MATCH 'startup'").get())
        .toEqual({ content: 'startup fixture' })
})

it('reopens the existing database without losing stored data', () => {
    const first = startDatabase()
    first.db.prepare('INSERT INTO memory(type, content) VALUES (?, ?)').run('fact', 'persisted fixture')
    first.db.close()

    const second = startDatabase()
    expect(second.DB_PATH).toBe(first.DB_PATH)
    expect(second.db.prepare('SELECT content FROM memory').all()).toEqual([{ content: 'persisted fixture' }])
})
