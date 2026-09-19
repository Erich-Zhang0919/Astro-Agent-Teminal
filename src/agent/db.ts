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
`)
