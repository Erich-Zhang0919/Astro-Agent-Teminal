import { randomUUID } from 'node:crypto'
import Table from 'cli-table3'
import stringWidth from 'string-width'
import type { SessionSummary } from './session-store'

export interface ChatSessionState {
    threadId: string
}

export type ChatCommandOutputLevel = 'info' | 'error'

export interface ChatCommandContext {
    session: ChatSessionState
    writeLine: (message: string, level?: ChatCommandOutputLevel) => void
}

export interface ChatCommandDefinition {
    name: string
    description: string
    usage: string
    execute: (rawArgs: string, context: ChatCommandContext) => void | Promise<void>
}

export interface ChatCommandDependencies {
    listRecentSessions: (limit: number) => Promise<SessionSummary[]>
    sessionExists: (threadId: string) => Promise<boolean>
    createThreadId?: () => string
    now?: () => Date
}

export class ChatCommandRegistry {
    private readonly commands = new Map<string, ChatCommandDefinition>()

    register(command: ChatCommandDefinition): this {
        const name = normalizeCommandName(command.name)

        if (this.commands.has(name)) {
            throw new Error(`Chat command already registered: /${name}`)
        }

        this.commands.set(name, { ...command, name })
        return this
    }

    list(): ChatCommandDefinition[] {
        return Array.from(this.commands.values())
    }

    suggest(input: string): ChatCommandDefinition[] {
        const trimmedInput = input.trimStart()
        if (!trimmedInput.startsWith('/') || /\s/.test(trimmedInput)) return []

        const prefix = trimmedInput.slice(1).toLowerCase()
        return this.list().filter(({ name }) => name.startsWith(prefix))
    }

    async dispatch(input: string, context: ChatCommandContext): Promise<boolean> {
        const parsed = parseChatCommand(input)
        if (!parsed) return false

        const command = this.commands.get(parsed.name)
        if (!command) {
            const availableCommands = this.list().map(({ name }) => `/${name}`).join(', ')
            const suffix = availableCommands ? ` Available commands: ${availableCommands}` : ''
            context.writeLine(`Unknown command: /${parsed.name}.${suffix}`, 'error')
            return true
        }

        try {
            await command.execute(parsed.rawArgs, context)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            context.writeLine(`Command /${command.name} failed: ${message}`, 'error')
        }

        return true
    }
}

export function createChatCommandRegistry({
    listRecentSessions,
    sessionExists,
    createThreadId = randomUUID,
    now = () => new Date(),
}: ChatCommandDependencies): ChatCommandRegistry {
    return new ChatCommandRegistry()
        .register({
            name: 'new',
            description: 'Start a new chat session',
            usage: '/new',
            execute: (rawArgs, context) => {
                if (rawArgs) {
                    context.writeLine('Usage: /new', 'error')
                    return
                }

                const threadId = createThreadId()
                context.session.threadId = threadId
                context.writeLine(`New session started: ${threadId}`)
            },
        })
        .register({
            name: 'sessions',
            description: 'List recent chat sessions',
            usage: '/sessions',
            execute: async (rawArgs, context) => {
                if (rawArgs) {
                    context.writeLine('Usage: /sessions', 'error')
                    return
                }

                const sessions = await listRecentSessions(20)
                if (sessions.length === 0) {
                    context.writeLine('No chat sessions found.')
                    return
                }

                context.writeLine(formatSessionsTable(sessions, now()))
            },
        })
        .register({
            name: 'rewind',
            description: 'Resume a previous chat session',
            usage: '/rewind <thread_id>',
            execute: async (rawArgs, context) => {
                if (!rawArgs) {
                    context.writeLine('Usage: /rewind <thread_id>', 'error')
                    return
                }

                if (!await sessionExists(rawArgs)) {
                    context.writeLine(`Session not found: ${rawArgs}`, 'error')
                    return
                }

                context.session.threadId = rawArgs
                context.writeLine(`Session restored: ${rawArgs}`)
            },
        })
}

export function formatSessionsTable(sessions: SessionSummary[], now: Date): string {
    const table = new Table({
        head: ['Thread_id', 'Final Question', 'Time'],
        colWidths: [38, 52, 12],
    })

    for (const { threadId, lastUserInput, lastUserInputAt } of sessions) {
        table.push([
            threadId,
            formatQuestion(lastUserInput),
            formatRelativeTime(lastUserInputAt, now),
        ])
    }

    return table.toString()
}

export function formatRelativeTime(date: Date, now: Date): string {
    const elapsedMs = Math.max(0, now.getTime() - date.getTime())
    const minute = 60_000
    const hour = 60 * minute
    const day = 24 * hour

    if (elapsedMs < minute) return '刚刚'
    if (elapsedMs < hour) return `${Math.floor(elapsedMs / minute)}分钟`
    if (elapsedMs < day) return `${Math.floor(elapsedMs / hour)}小时`
    if (elapsedMs < 30 * day) return `${Math.floor(elapsedMs / day)}天`

    const monthAndDay = `${date.getMonth() + 1}月${date.getDate()}日`
    return date.getFullYear() === now.getFullYear()
        ? monthAndDay
        : `${date.getFullYear()}年${monthAndDay}`
}

function formatQuestion(question: string): string {
    const normalized = question.replace(/\s+/gu, ' ').trim() || '（无文本内容）'
    const characters = Array.from(normalized)
    const truncated = characters.length > 50
        ? `${characters.slice(0, 50).join('')}…`
        : normalized

    return wrapTableCell(truncated, 50)
}

function wrapTableCell(value: string, maxWidth: number): string {
    const lines: string[] = []
    let line = ''
    let lineWidth = 0

    for (const character of Array.from(value)) {
        const characterWidth = stringWidth(character)
        if (line && lineWidth + characterWidth > maxWidth) {
            lines.push(line)
            line = ''
            lineWidth = 0
        }

        line += character
        lineWidth += characterWidth
    }

    if (line) lines.push(line)
    return lines.join('\n')
}

function normalizeCommandName(name: string): string {
    const normalized = name.trim().replace(/^\//, '').toLowerCase()

    if (!/^[a-z][a-z0-9_-]*$/.test(normalized)) {
        throw new Error(`Invalid chat command name: ${name}`)
    }

    return normalized
}

function parseChatCommand(input: string): { name: string; rawArgs: string } | undefined {
    const trimmedInput = input.trim()
    if (!trimmedInput.startsWith('/')) return undefined

    const separatorIndex = trimmedInput.search(/\s/)
    const commandToken = separatorIndex === -1
        ? trimmedInput
        : trimmedInput.slice(0, separatorIndex)
    const rawArgs = separatorIndex === -1
        ? ''
        : trimmedInput.slice(separatorIndex).trim()

    return {
        name: commandToken.slice(1).toLowerCase(),
        rawArgs,
    }
}
