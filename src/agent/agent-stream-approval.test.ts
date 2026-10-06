import { Command } from '@langchain/langgraph'
import type { createAgentGraph } from './agent-graph'
import { runGraphWithApprovals } from './agent-runner'

type AgentGraph = ReturnType<typeof createAgentGraph>

const request = {
    name: 'read_file', args: { file_path: 'a.txt' }, toolCallId: 'call_1',
    index: 1, total: 1,
}

function messageStream(content: string) {
    return (async function* () {
        yield [{ content }, { langgraph_node: 'model_request' }]
    })()
}

function graphWithSnapshots(pending: boolean[], contents: string[]) {
    const getState = jest.fn()
    for (const isPending of pending) {
        getState.mockResolvedValueOnce({
            tasks: isPending ? [{ interrupts: [{ value: request }] }] : [],
        })
    }
    const stream = jest.fn()
    for (const content of contents) {
        stream.mockResolvedValueOnce(messageStream(content))
    }
    return { graph: { getState, stream } as unknown as AgentGraph, getState, stream }
}

const config = (threadId: string) => ({ configurable: { thread_id: threadId } })

describe('streamed tool approvals', () => {
    it('streams, requests approval, and resumes with a positive decision', async () => {
        const { graph, stream } = graphWithSnapshots([false, true, false], ['before', 'after'])
        const confirmTool = jest.fn(async () => true)
        const tokens: string[] = []

        const result = await runGraphWithApprovals(graph, 'question',
            (token) => tokens.push(token), config('stream-approval'), 'model',
            undefined, confirmTool)

        expect(confirmTool).toHaveBeenCalledWith(request)
        expect(stream).toHaveBeenCalledTimes(2)
        expect(stream.mock.calls[1][0]).toBeInstanceOf(Command)
        expect((stream.mock.calls[1][0] as Command).resume).toEqual({ approved: true })
        expect(tokens.join('')).toBe('beforeafter')
        expect(result.text).toBe('beforeafter')
    })

    it('denies by default when no confirmation callback is supplied', async () => {
        const { graph, stream } = graphWithSnapshots([false, true, false], ['', 'done'])

        await runGraphWithApprovals(graph, 'question', () => undefined,
            config('default-deny'), 'model')
        expect((stream.mock.calls[1][0] as Command).resume).toEqual({ approved: false })
    })

    it('resolves an older pending approval before adding a new user message', async () => {
        const { graph, stream } = graphWithSnapshots([true, false, false], ['old', 'new'])

        await runGraphWithApprovals(graph, 'next question', () => undefined,
            config('pending-first'), 'model')
        expect(stream.mock.calls[0][0]).toBeInstanceOf(Command)
        expect((stream.mock.calls[0][0] as Command).resume).toEqual({ approved: false })
        expect(stream.mock.calls[1][0]).toEqual({
            messages: [{ role: 'user', content: 'next question' }],
        })
    })

    it('leaves the checkpoint suspended when cancelled during confirmation', async () => {
        const controller = new AbortController()
        const { graph, stream } = graphWithSnapshots([false, true], ['before'])

        await runGraphWithApprovals(graph, 'question', () => undefined,
            config('cancelled'), 'model', controller.signal,
            async () => { controller.abort(); return true })
        expect(stream).toHaveBeenCalledTimes(1)
    })
})
