import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import { tool } from '@langchain/core/tools'
import { Command, MemorySaver } from '@langchain/langgraph'
import { z } from 'zod'
import { createAgentGraph, ToolApprovalRequest } from './agent-graph'
import { runGraphWithApprovals } from './agent-runner'
import { requestToolApproval } from './tool-approval'

jest.mock('./tools', () => ({ maybePersistedOutput: async (content: string) => content }))

function setupGraph() {
    const first = jest.fn(async ({ value }: { value: string }) => `first:${value}`)
    const second = jest.fn(async ({ value }: { value: string }) => `second:${value}`)
    const calls = [
        { name: 'first', id: 'call_1', args: { value: 'one' }, type: 'tool_call' as const },
        { name: 'second', id: 'call_2', args: { value: 'two' }, type: 'tool_call' as const },
    ]
    const invoke = jest.fn()
        .mockResolvedValueOnce(new AIMessage({ content: '', tool_calls: calls }))
        .mockResolvedValue(new AIMessage('done'))
    const model = { bindTools: () => ({ invoke }) } as unknown as BaseChatModel
    const checkpointer = new MemorySaver()
    const tools = [
        tool(first, { name: 'first', schema: z.object({ value: z.string() }) }),
        tool(second, { name: 'second', schema: z.object({ value: z.string() }) }),
    ]
    const graph = createAgentGraph({ model, tools, systemPrompt: 'test', checkpointer })
    return { graph, invoke, first, second, model, tools, checkpointer }
}

async function pendingRequest(
    graph: ReturnType<typeof setupGraph>['graph'],
    config: { configurable: { thread_id: string } },
): Promise<ToolApprovalRequest | undefined> {
    const snapshot = await graph.getState(config)
    return snapshot.tasks.flatMap((task) => task.interrupts)[0]?.value as
        ToolApprovalRequest | undefined
}

describe('tool approval graph', () => {
    it('uses streamed interrupts to confirm each call in a real graph run', async () => {
        const { graph, first, second } = setupGraph()
        const confirmTool = jest.fn(async (pending: ToolApprovalRequest) =>
            pending.name === 'second')
        const tokens: string[] = []

        const result = await runGraphWithApprovals(graph, 'run tools',
            (token) => tokens.push(token),
            { configurable: { thread_id: 'streamed-real-graph' } },
            'test-model', undefined, confirmTool)

        expect(confirmTool.mock.calls.map(([pending]) => pending.name))
            .toEqual(['first', 'second'])
        expect(first).not.toHaveBeenCalled()
        expect(second).toHaveBeenCalledTimes(1)
        expect(result.text).toContain('done')
        expect(tokens.join('')).toContain('done')
    })

    it('asks for each call and runs no tool until every decision is collected', async () => {
        const { graph, first, second, invoke } = setupGraph()
        const config = { configurable: { thread_id: 'approve-both' } }

        await graph.invoke({ messages: [new HumanMessage('run tools')] }, config)
        expect(await pendingRequest(graph, config)).toMatchObject({
            name: 'first', toolCallId: 'call_1', args: { value: 'one' }, index: 1, total: 2,
        })
        expect(first).not.toHaveBeenCalled()
        expect(second).not.toHaveBeenCalled()

        await graph.invoke(new Command({ resume: { approved: true } }), config)
        expect(await pendingRequest(graph, config)).toMatchObject({
            name: 'second', toolCallId: 'call_2', args: { value: 'two' }, index: 2, total: 2,
        })
        expect(first).not.toHaveBeenCalled()
        expect(second).not.toHaveBeenCalled()

        const result = await graph.invoke(new Command({ resume: { approved: true } }), config)
        expect(first).toHaveBeenCalledTimes(1)
        expect(second).toHaveBeenCalledTimes(1)
        expect(result.messages.filter(ToolMessage.isInstance).map((message) => message.content))
            .toEqual(['first:one', 'second:two'])
        expect(invoke).toHaveBeenCalledTimes(2)
    })

    it('runs only approved calls and tells the model which call was rejected', async () => {
        const { graph, first, second, invoke } = setupGraph()
        const config = { configurable: { thread_id: 'mixed' } }

        await graph.invoke({ messages: [new HumanMessage('run tools')] }, config)
        await graph.invoke(new Command({ resume: { approved: false } }), config)
        const result = await graph.invoke(new Command({ resume: { approved: true } }), config)

        expect(first).not.toHaveBeenCalled()
        expect(second).toHaveBeenCalledTimes(1)
        const messages = result.messages.filter(ToolMessage.isInstance)
        expect(messages.map((message) => message.tool_call_id)).toEqual(['call_1', 'call_2'])
        expect(messages[0]).toMatchObject({ status: 'error' })
        expect(messages[0].content).toContain('user rejected')
        const nextModelMessages = invoke.mock.calls[1][0] as BaseMessage[]
        expect(nextModelMessages.filter(ToolMessage.isInstance)).toEqual(messages)
    })

    it('continues without invoking any tool when all calls are rejected', async () => {
        const { graph, first, second, invoke } = setupGraph()
        const config = { configurable: { thread_id: 'reject-both' } }

        await graph.invoke({ messages: [new HumanMessage('run tools')] }, config)
        await graph.invoke(new Command({ resume: { approved: false } }), config)
        const result = await graph.invoke(new Command({ resume: { approved: false } }), config)

        expect(first).not.toHaveBeenCalled()
        expect(second).not.toHaveBeenCalled()
        expect(result.messages.filter(ToolMessage.isInstance)).toHaveLength(2)
        expect(invoke).toHaveBeenCalledTimes(2)
    })

    it('never executes a rejected call even when the model omitted its call ID', async () => {
        const execute = jest.fn(async () => 'ran')
        const invoke = jest.fn()
            .mockResolvedValueOnce(new AIMessage({
                content: '',
                tool_calls: [{ name: 'idless', args: {}, type: 'tool_call' }],
            }))
            .mockResolvedValue(new AIMessage('done'))
        const model = { bindTools: () => ({ invoke }) } as unknown as BaseChatModel
        const graph = createAgentGraph({
            model,
            tools: [tool(execute, { name: 'idless', schema: z.object({}) })],
            systemPrompt: 'test',
            checkpointer: new MemorySaver(),
        })
        const config = { configurable: { thread_id: 'idless' } }

        await graph.invoke({ messages: [new HumanMessage('run tool')] }, config)
        await graph.invoke(new Command({ resume: { approved: false } }), config)
        expect(execute).not.toHaveBeenCalled()
    })

    it('executes a newly approved call even if an earlier turn used the same call ID', async () => {
        const execute = jest.fn(async () => 'ran')
        const toolCall = { name: 'repeat', id: 'reused', args: {}, type: 'tool_call' as const }
        const invoke = jest.fn()
            .mockResolvedValueOnce(new AIMessage({ content: '', tool_calls: [toolCall] }))
            .mockResolvedValueOnce(new AIMessage('first done'))
            .mockResolvedValueOnce(new AIMessage({ content: '', tool_calls: [toolCall] }))
            .mockResolvedValue(new AIMessage('second done'))
        const model = { bindTools: () => ({ invoke }) } as unknown as BaseChatModel
        const graph = createAgentGraph({
            model,
            tools: [tool(execute, { name: 'repeat', schema: z.object({}) })],
            systemPrompt: 'test', checkpointer: new MemorySaver(),
        })
        const config = { configurable: { thread_id: 'reused-id' } }

        await graph.invoke({ messages: [new HumanMessage('first')] }, config)
        await graph.invoke(new Command({ resume: { approved: true } }), config)
        await graph.invoke({ messages: [new HumanMessage('second')] }, config)
        await graph.invoke(new Command({ resume: { approved: true } }), config)

        expect(execute).toHaveBeenCalledTimes(2)
    })

    it('rebuilds the preprocessed model context after restoring a checkpoint', async () => {
        const { graph, model, tools, checkpointer, invoke } = setupGraph()
        const config = {
            configurable: { thread_id: 'restart' },
            context: { preprocessMessages: jest.fn(async (messages: readonly BaseMessage[]) =>
                [new HumanMessage('processed'), ...messages.slice(1)]) },
        }

        await graph.invoke({ messages: [new HumanMessage('original')] }, config)
        const restoredGraph = createAgentGraph({ model, tools, systemPrompt: 'test', checkpointer })
        await restoredGraph.invoke(new Command({ resume: { approved: true } }), config)
        const result = await restoredGraph.invoke(new Command({ resume: { approved: true } }), config)

        expect(result.messages.at(-1)?.content).toBe('done')
        expect(config.context.preprocessMessages).toHaveBeenCalledTimes(2)
        const nextModelMessages = invoke.mock.calls[1][0] as BaseMessage[]
        expect(nextModelMessages[1].content).toBe('processed')
        expect(nextModelMessages.filter(ToolMessage.isInstance)).toHaveLength(2)
    })
})

describe('CLI tool confirmation', () => {
    const request: ToolApprovalRequest = {
        toolCallId: 'call_1', name: 'write_file', args: { file_path: 'a.txt', content: 'hello' },
        index: 1, total: 2,
    }

    it.each([['y', true], [' YES ', true], ['n', false], ['', false], ['sure', false]])(
        'accepts only an explicit yes (%s)', async (answer, expected) => {
            const output: string[] = []
            const readAnswer = jest.fn(async () => answer)
            const approved = await requestToolApproval(request, {
                interactive: true, readAnswer, write: (text) => output.push(text),
            })
            expect(approved).toBe(expected)
            expect(readAnswer).toHaveBeenCalledWith('Approve this tool call? [y/N] ')
            expect(output.join('')).toContain('"content": "hello"')
        },
    )

    it('denies without a terminal or after prompt failure', async () => {
        const output: string[] = []
        const readAnswer = jest.fn(async () => 'yes')
        expect(await requestToolApproval(request, {
            interactive: false, readAnswer, write: (text) => output.push(text),
        })).toBe(false)
        expect(readAnswer).not.toHaveBeenCalled()
        expect(output.join('')).toContain('no interactive terminal')

        expect(await requestToolApproval(request, {
            interactive: true,
            readAnswer: async () => { throw new Error('closed') },
            write: (text) => output.push(text),
        })).toBe(false)
    })
})
