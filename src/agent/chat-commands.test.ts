import {
    ChatCommandDependencies,
    ChatCommandRegistry,
    ChatSessionState,
    createChatCommandRegistry,
    formatRelativeTime,
} from './chat-commands'

describe('ChatCommandRegistry', () => {
    const createContext = (threadId = 'initial-thread') => {
        const session: ChatSessionState = { threadId }
        const writeLine = jest.fn()
        return { session, writeLine, context: { session, writeLine } }
    }

    const createRegistry = (overrides: Partial<ChatCommandDependencies> = {}) =>
        createChatCommandRegistry({
            listRecentSessions: async () => [],
            sessionExists: async () => false,
            createThreadId: () => 'new-thread',
            now: () => new Date('2026-08-23T12:00:00.000Z'),
            ...overrides,
        })

    it('does not handle regular chat messages', async () => {
        const registry = createRegistry()
        const { context, writeLine } = createContext()

        await expect(registry.dispatch('hello', context)).resolves.toBe(false)
        expect(writeLine).not.toHaveBeenCalled()
    })

    it('suggests commands as a slash-command prefix is typed', () => {
        const registry = createRegistry()

        expect(registry.suggest('/').map(({ name }) => name)).toEqual([
            'new',
            'sessions',
            'rewind',
        ])
        expect(registry.suggest('/S').map(({ name }) => name)).toEqual(['sessions'])
        expect(registry.suggest('/re').map(({ name }) => name)).toEqual(['rewind'])
        expect(registry.suggest('/rewind ')).toEqual([])
        expect(registry.suggest('regular message')).toEqual([])
    })

    it.each(['/new', '  /new  ', '/NEW'])(
        'starts a new session for %s',
        async (input) => {
            const registry = createRegistry()
            const { context, session, writeLine } = createContext()

            await expect(registry.dispatch(input, context)).resolves.toBe(true)
            expect(session.threadId).toBe('new-thread')
            expect(writeLine).toHaveBeenCalledWith('New session started: new-thread')
        },
    )

    it('creates a different session each time /new is executed', async () => {
        const createThreadId = jest.fn()
            .mockReturnValueOnce('second-thread')
            .mockReturnValueOnce('third-thread')
        const registry = createRegistry({ createThreadId })
        const { context, session } = createContext('first-thread')

        await registry.dispatch('/new', context)
        expect(session.threadId).toBe('second-thread')

        await registry.dispatch('/new', context)
        expect(session.threadId).toBe('third-thread')
    })

    it('rejects arguments for /new without changing the session', async () => {
        const registry = createRegistry({ createThreadId: () => 'unused-thread' })
        const { context, session, writeLine } = createContext()

        await expect(registry.dispatch('/new extra', context)).resolves.toBe(true)
        expect(session.threadId).toBe('initial-thread')
        expect(writeLine).toHaveBeenCalledWith('Usage: /new', 'error')
    })

    it('handles unknown slash commands locally and lists available commands', async () => {
        const registry = createRegistry()
        const { context, writeLine } = createContext()

        await expect(registry.dispatch('/missing', context)).resolves.toBe(true)
        expect(writeLine).toHaveBeenCalledWith(
            'Unknown command: /missing. Available commands: /new, /sessions, /rewind',
            'error',
        )
    })

    it('restores an existing session', async () => {
        const sessionExists = jest.fn().mockResolvedValue(true)
        const registry = createRegistry({ sessionExists })
        const { context, session, writeLine } = createContext()

        await expect(registry.dispatch('/rewind restored-thread', context)).resolves.toBe(true)

        expect(sessionExists).toHaveBeenCalledWith('restored-thread')
        expect(session.threadId).toBe('restored-thread')
        expect(writeLine).toHaveBeenCalledWith('Session restored: restored-thread')
    })

    it('keeps the current session when the requested session does not exist', async () => {
        const sessionExists = jest.fn().mockResolvedValue(false)
        const registry = createRegistry({ sessionExists })
        const { context, session, writeLine } = createContext()

        await registry.dispatch('/rewind missing-thread', context)

        expect(session.threadId).toBe('initial-thread')
        expect(writeLine).toHaveBeenCalledWith('Session not found: missing-thread', 'error')
    })

    it('requires a thread ID for /rewind', async () => {
        const sessionExists = jest.fn()
        const registry = createRegistry({ sessionExists })
        const { context, session, writeLine } = createContext()

        await registry.dispatch('/rewind', context)

        expect(sessionExists).not.toHaveBeenCalled()
        expect(session.threadId).toBe('initial-thread')
        expect(writeLine).toHaveBeenCalledWith('Usage: /rewind <thread_id>', 'error')
    })

    it('keeps the current session when checking /rewind fails', async () => {
        const registry = createRegistry({
            sessionExists: async () => {
                throw new Error('database unavailable')
            },
        })
        const { context, session, writeLine } = createContext()

        await expect(registry.dispatch('/rewind target-thread', context)).resolves.toBe(true)

        expect(session.threadId).toBe('initial-thread')
        expect(writeLine).toHaveBeenCalledWith(
            'Command /rewind failed: database unavailable',
            'error',
        )
    })

    it('lists recent sessions without changing the active session', async () => {
        const listRecentSessions = jest.fn().mockResolvedValue([
            {
                threadId: '11111111-1111-4111-8111-111111111111',
                lastUserInput: `${'你'.repeat(51)} | next\nline`,
                lastUserInputAt: new Date('2026-08-23T11:55:00.000Z'),
            },
            {
                threadId: '22222222-2222-4222-8222-222222222222',
                lastUserInput: '',
                lastUserInputAt: new Date('2026-08-23T11:59:30.000Z'),
            },
        ])
        const registry = createRegistry({ listRecentSessions })
        const { context, session, writeLine } = createContext()

        await expect(registry.dispatch('/sessions', context)).resolves.toBe(true)

        expect(session.threadId).toBe('initial-thread')
        expect(listRecentSessions).toHaveBeenCalledWith(20)
        const output = writeLine.mock.calls[0][0] as string
        expect(output).toContain('┌')
        expect(output).toContain('thread_id')
        expect(output).toContain('11111111-1111-4111-8111-111111111111')
        expect(output).toContain('22222222-2222-4222-8222-222222222222')
        expect(output.match(/你/g)).toHaveLength(50)
        expect(output).toContain('…')
        expect(output).toContain('5分钟')
        expect(output).toContain('（无文本内容）')
        expect(output).toContain('刚刚')
        expect(output).not.toContain('| ---')
    })

    it('normalizes whitespace and escapes pipes in session questions', async () => {
        const registry = createRegistry({
            listRecentSessions: async () => [{
                threadId: 'thread-id',
                lastUserInput: 'first | second\n third',
                lastUserInputAt: new Date('2026-08-23T11:00:00.000Z'),
            }],
        })
        const { context, writeLine } = createContext()

        await registry.dispatch('/sessions', context)

        expect(writeLine).toHaveBeenCalledWith(expect.stringContaining('first | second third'))
    })

    it('rejects arguments for /sessions without querying storage', async () => {
        const listRecentSessions = jest.fn()
        const registry = createRegistry({ listRecentSessions })
        const { context, writeLine } = createContext()

        await registry.dispatch('/sessions extra', context)

        expect(listRecentSessions).not.toHaveBeenCalled()
        expect(writeLine).toHaveBeenCalledWith('Usage: /sessions', 'error')
    })

    it('reports when no sessions have been stored', async () => {
        const registry = createRegistry()
        const { context, writeLine } = createContext()

        await registry.dispatch('/sessions', context)

        expect(writeLine).toHaveBeenCalledWith('No chat sessions found.')
    })

    it('reports session query failures without leaving the chat loop', async () => {
        const registry = createRegistry({
            listRecentSessions: async () => {
                throw new Error('database unavailable')
            },
        })
        const { context, writeLine } = createContext()

        await expect(registry.dispatch('/sessions', context)).resolves.toBe(true)
        expect(writeLine).toHaveBeenCalledWith(
            'Command /sessions failed: database unavailable',
            'error',
        )
    })

    it('preserves spacing inside raw command arguments', async () => {
        const execute = jest.fn()
        const registry = new ChatCommandRegistry().register({
            name: 'skill',
            description: 'Use a skill',
            usage: '/skill <name>',
            execute,
        })
        const { context } = createContext()

        await registry.dispatch('  /skill   code-review   with notes  ', context)

        expect(execute).toHaveBeenCalledWith('code-review   with notes', context)
    })

    it('reports command failures without rejecting dispatch', async () => {
        const registry = new ChatCommandRegistry().register({
            name: 'fail',
            description: 'Fail',
            usage: '/fail',
            execute: () => {
                throw new Error('boom')
            },
        })
        const { context, writeLine } = createContext()

        await expect(registry.dispatch('/fail', context)).resolves.toBe(true)
        expect(writeLine).toHaveBeenCalledWith('Command /fail failed: boom', 'error')
    })

    it('rejects duplicate command names case-insensitively', () => {
        const registry = new ChatCommandRegistry().register({
            name: 'new',
            description: 'First',
            usage: '/new',
            execute: () => undefined,
        })

        expect(() => registry.register({
            name: 'NEW',
            description: 'Second',
            usage: '/new',
            execute: () => undefined,
        })).toThrow('Chat command already registered: /new')
    })
})

describe('formatRelativeTime', () => {
    const now = new Date(2026, 7, 23, 12, 0, 0)

    it.each([
        [new Date(2026, 7, 23, 11, 59, 1), '刚刚'],
        [new Date(2026, 7, 23, 11, 59, 0), '1分钟'],
        [new Date(2026, 7, 23, 11, 55, 0), '5分钟'],
        [new Date(2026, 7, 23, 10, 0, 0), '2小时'],
        [new Date(2026, 7, 20, 12, 0, 0), '3天'],
        [new Date(2026, 6, 20, 12, 0, 0), '7月20日'],
        [new Date(2025, 11, 20, 12, 0, 0), '2025年12月20日'],
        [new Date(2026, 7, 23, 12, 1, 0), '刚刚'],
    ])('formats %s as %s', (date, expected) => {
        expect(formatRelativeTime(date, now)).toBe(expected)
    })
})
