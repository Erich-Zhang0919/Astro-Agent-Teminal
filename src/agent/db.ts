import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'

export const DB_PATH = resolve(process.cwd(), '.data', 'checkpointer.db')
mkdirSync(dirname(DB_PATH), { recursive: true })

export const checkpointer = SqliteSaver.fromConnString(DB_PATH)
export const db = checkpointer.db

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
