import { AIMessage, HumanMessage } from '@langchain/core/messages'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { SessionStore } from './session-store'

jest.mock('uuid', () => ({
    v5: jest.fn(),
    v6: jest.fn(),
}), { virtual: true })

describe('SessionStore', () => {
    it('returns the latest user input from each recent session', async () => {
        const checkpointer = SqliteSaver.fromConnString(':memory:')
        const store = new SessionStore(checkpointer)

        try {
            await putCheckpoint(checkpointer, 'thread-c', '001', '2026-08-23T09:00:00.000Z', [
                new HumanMessage('question c'),
            ])
            await putCheckpoint(checkpointer, 'thread-a', '002', '2026-08-23T10:00:00.000Z', [
                new HumanMessage('old question a'),
            ])
            await putCheckpoint(checkpointer, 'thread-a', '003', '2026-08-23T10:00:01.000Z', [
                new HumanMessage('old question a'),
                new AIMessage('old answer a'),
            ])
            await putCheckpoint(checkpointer, 'thread-a', '004', '2026-08-23T11:00:00.000Z', [
                new HumanMessage('old question a'),
                new AIMessage('old answer a'),
                new HumanMessage('latest question a'),
            ])
            await putCheckpoint(checkpointer, 'thread-a', '005', '2026-08-23T11:00:01.000Z', [
                new HumanMessage('old question a'),
                new AIMessage('old answer a'),
                new HumanMessage('latest question a'),
                new AIMessage('latest answer a'),
            ])
            await putCheckpoint(checkpointer, 'thread-b', '006', '2026-08-23T12:00:00.000Z', [
                new HumanMessage({
                    content: [
                        { type: 'text', text: 'block one' },
                        { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
                        { type: 'text', text: 'block two' },
                    ],
                }),
            ])
            await putCheckpoint(checkpointer, 'thread-b', '007', '2026-08-23T12:00:01.000Z', [
                new HumanMessage('question b'),
                new AIMessage('answer b'),
            ])

            await expect(store.hasSession('thread-a')).resolves.toBe(true)
            await expect(store.hasSession('missing-thread')).resolves.toBe(false)

            const sessions = await store.listRecentSessions(2)

            expect(sessions).toEqual([
                {
                    threadId: 'thread-b',
                    lastUserInput: 'block one block two',
                    lastUserInputAt: new Date('2026-08-23T12:00:00.000Z'),
                },
                {
                    threadId: 'thread-a',
                    lastUserInput: 'latest question a',
                    lastUserInputAt: new Date('2026-08-23T11:00:00.000Z'),
                },
            ])
        } finally {
            checkpointer.db.close()
        }
    })

    it.each([0, -1, 1.5])('returns no sessions for invalid limit %s', async (limit) => {
        const checkpointer = SqliteSaver.fromConnString(':memory:')
        const store = new SessionStore(checkpointer)

        try {
            await expect(store.listRecentSessions(limit)).resolves.toEqual([])
        } finally {
            checkpointer.db.close()
        }
    })
})

async function putCheckpoint(
    checkpointer: SqliteSaver,
    threadId: string,
    checkpointId: string,
    timestamp: string,
    messages: Array<HumanMessage | AIMessage>,
): Promise<void> {
    await checkpointer.put(
        { configurable: { thread_id: threadId } },
        {
            v: 4,
            id: checkpointId,
            ts: timestamp,
            channel_values: { messages },
            channel_versions: {},
            versions_seen: {},
        },
        { source: 'loop', step: 0, parents: {} },
    )
}
