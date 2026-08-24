import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'

export interface SessionSummary {
    threadId: string
    lastUserInput: string
    lastUserInputAt: Date
}

interface StoredMessage {
    content?: unknown
    getType?: () => string
    _getType?: () => string
    type?: string
}

export class SessionStore {
    constructor(readonly checkpointer: SqliteSaver) {}

    async hasSession(threadId: string): Promise<boolean> {
        if (!threadId) return false

        const checkpoint = await this.checkpointer.getTuple({
            configurable: {
                thread_id: threadId,
                checkpoint_ns: '',
            },
        })

        return checkpoint !== undefined
    }

    async listRecentSessions(limit: number): Promise<SessionSummary[]> {
        if (!Number.isInteger(limit) || limit <= 0) return []

        const sessions: SessionSummary[] = []
        const foundThreads = new Set<string>()

        for await (const tuple of this.checkpointer.list({
            configurable: { checkpoint_ns: '' },
        })) {
            const threadId = tuple.config.configurable?.thread_id
            if (typeof threadId !== 'string' || foundThreads.has(threadId)) continue

            const messages = tuple.checkpoint.channel_values.messages
            if (!Array.isArray(messages) || messages.length === 0) continue

            const lastMessage = messages[messages.length - 1] as StoredMessage
            if (getMessageType(lastMessage) !== 'human') continue

            const lastUserInputAt = new Date(tuple.checkpoint.ts)
            if (Number.isNaN(lastUserInputAt.getTime())) continue

            foundThreads.add(threadId)
            sessions.push({
                threadId,
                lastUserInput: getMessageText(lastMessage.content),
                lastUserInputAt,
            })

            if (sessions.length >= limit) break
        }

        return sessions.sort(
            (left, right) => right.lastUserInputAt.getTime() - left.lastUserInputAt.getTime(),
        )
    }
}

function getMessageType(message: StoredMessage): string | undefined {
    return message.getType?.() ?? message._getType?.() ?? message.type
}

function getMessageText(content: unknown): string {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''

    return content
        .map((block) => {
            if (typeof block === 'string') return block
            if (block && typeof block === 'object' && 'text' in block) {
                const text = (block as { text?: unknown }).text
                return typeof text === 'string' ? text : ''
            }
            return ''
        })
        .filter(Boolean)
        .join(' ')
}

export const checkpointerPath = resolve(process.cwd(), '.data', 'checkpointer.db')
mkdirSync(dirname(checkpointerPath), { recursive: true })

export const checkpointer = SqliteSaver.fromConnString(checkpointerPath)
export const sessionStore = new SessionStore(checkpointer)
