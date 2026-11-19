import { DB_PATH, initializeDatabase } from '../install'

export { DB_PATH }
export const checkpointer = initializeDatabase()
export const db = checkpointer.db
