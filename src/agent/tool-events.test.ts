import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import { tool } from '@langchain/core/tools'
import { Command, MemorySaver } from '@langchain/langgraph'
import { z } from 'zod'
import { createAgentGraph } from './agent-graph'
import { runGraphWithApprovals } from './agent-runner'
import { withPermissionLevel } from './permission/util'
import type { ToolExecutionEvent } from './tool-events'

jest.mock('./tools', () => ({ maybePersistedOutput: async (content: string) => content }))

function graphFor(tools: Parameters<typeof createAgentGraph>[0]['tools'], calls: {
    name: string; id: string; args: Record<string, unknown>
}[]) {
    const invoke = jest.fn()
        .mockResolvedValueOnce(new AIMessage({ content: '', tool_calls: calls }))
        .mockResolvedValue(new AIMessage('done'))
    const graph = createAgentGraph({
        model: { bindTools: () => ({ invoke }) } as unknown as BaseChatModel,
        tools, systemPrompt: 'test', checkpointer: new MemorySaver(),
    })
    const onToolEvent = jest.fn<void, [ToolExecutionEvent]>()
    const config = { configurable: { thread_id: 'tool-events' }, context: { onToolEvent } }
    return { graph, invoke, onToolEvent, config }
}

it('reports an auto-approved exec call and its result separately from reply tokens', async () => {
    const execute = jest.fn(async () => 'agent\nindex.js')
    const call = { name: 'exec', id: 'exec-call', args: { command: 'ls -la dist' } }
    const { graph, onToolEvent, config } = graphFor([
        withPermissionLevel(tool(execute, { name: 'exec', schema: z.object({ command: z.string() }) }), 'exec'),
    ], [call])
    const confirmTool = jest.fn(async () => true)
    const tokens: string[] = []
    const result = await runGraphWithApprovals(graph, 'list dist', token => tokens.push(token),
        config, 'model', undefined, confirmTool)
    expect(confirmTool).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(onToolEvent.mock.calls.map(([event]) => event)).toEqual([
        { type: 'start', toolCallId: call.id, name: call.name, args: call.args },
        { type: 'result', toolCallId: call.id, name: call.name, args: call.args,
            status: 'success', content: 'agent\nindex.js' },
    ])
    expect(tokens.join('')).toBe('done')
    expect(result.text).toBe('done')
})

it('reports an execution error while preserving the tool error for the model', async () => {
    const execute = jest.fn(async () => { throw new Error('file missing') })
    const { graph, onToolEvent, config, invoke } = graphFor([
        tool(execute, { name: 'broken', schema: z.object({}) }),
    ], [{ name: 'broken', id: 'broken-call', args: {} }])
    await graph.invoke({ messages: [new HumanMessage('run')] }, config)
    expect(onToolEvent.mock.calls[1][0]).toMatchObject({
        type: 'result', status: 'error', content: expect.stringContaining('file missing'),
    })
    expect(invoke.mock.calls[1][0].filter(ToolMessage.isInstance)[0].status).toBe('error')
})

it('reports permission-blocked calls without a start event or actual execution', async () => {
    const execute = jest.fn(async () => 'should not run')
    const { graph, onToolEvent, config } = graphFor([
        withPermissionLevel(tool(execute, { name: 'exec', schema: z.object({ command: z.string() }) }), 'exec'),
    ], [{ name: 'exec', id: 'blocked-call', args: { command: 'rm -rf .' } }])
    await graph.invoke({ messages: [new HumanMessage('run')] }, config)
    expect(execute).not.toHaveBeenCalled()
    expect(onToolEvent).toHaveBeenCalledTimes(1)
    expect(onToolEvent.mock.calls[0][0]).toMatchObject({
        type: 'result', status: 'blocked', content: expect.stringContaining('Blocked'),
    })
})

it('reports rejection and approval only once after all approval interrupts resolve', async () => {
    const execute = jest.fn(async () => 'ran')
    const item = withPermissionLevel(tool(execute, {
        name: 'exec', schema: z.object({ command: z.string() }),
    }), 'exec')
    const { graph, onToolEvent, config } = graphFor([item], [
        { name: 'exec', id: 'rejected', args: { command: 'true' } },
        { name: 'exec', id: 'approved', args: { command: 'true' } },
    ])
    await graph.invoke({ messages: [new HumanMessage('run')] }, config)
    expect(onToolEvent).not.toHaveBeenCalled()
    await graph.invoke(new Command({ resume: { approved: false } }), config)
    expect(onToolEvent).not.toHaveBeenCalled()
    await graph.invoke(new Command({ resume: { approved: true } }), config)
    expect(onToolEvent.mock.calls.map(([event]) => [event.toolCallId, event.type])).toEqual([
        ['rejected', 'result'], ['approved', 'start'], ['approved', 'result'],
    ])
    expect(execute).toHaveBeenCalledTimes(1)
})

it('reports each parallel tool as it completes, even while a sibling is still running', async () => {
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    let secondDone!: () => void
    const completion = new Promise<void>(resolve => { secondDone = resolve })
    const { graph, onToolEvent, config } = graphFor([
        tool(async () => { await waiting; return 'first output' }, { name: 'first', schema: z.object({}) }),
        tool(async () => 'second output', { name: 'second', schema: z.object({}) }),
    ], [
        { name: 'first', id: 'first', args: {} }, { name: 'second', id: 'second', args: {} },
    ])
    onToolEvent.mockImplementation(event => {
        if (event.name === 'second' && event.type === 'result') secondDone()
    })
    const running = graph.invoke({ messages: [new HumanMessage('run')] }, config)
    try {
        await completion
        expect(onToolEvent.mock.calls.some(([event]) =>
            event.name === 'first' && event.type === 'result')).toBe(false)
        expect(onToolEvent.mock.calls.some(([event]) =>
            event.name === 'second' && event.type === 'result')).toBe(true)
    } finally {
        release()
        await running
    }
    expect(onToolEvent).toHaveBeenCalledTimes(4)
})

it('does not fail or repeat tools when an event observer rejects', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const execute = jest.fn(async () => 'ran')
    const { graph, config } = graphFor([
        tool(execute, { name: 'test', schema: z.object({}) }),
    ], [{ name: 'test', id: 'test', args: {} }])
    try {
        await graph.invoke({ messages: [new HumanMessage('run')] }, {
            ...config, context: { onToolEvent: async () => { throw new Error('display failed') } },
        })
        expect(execute).toHaveBeenCalledTimes(1)
        expect(error).toHaveBeenCalledTimes(2)
    } finally {
        error.mockRestore()
    }
})

it('reports tool messages returned through Command updates', async () => {
    const { graph, onToolEvent, config } = graphFor([
        tool(async () => new Command({ update: {
            messages: [new ToolMessage({ tool_call_id: 'command', content: 'command output' })],
        } }), { name: 'command_tool', schema: z.object({}) }),
    ], [{ name: 'command_tool', id: 'command', args: {} }])
    await graph.invoke({ messages: [new HumanMessage('run')] }, config)
    expect(onToolEvent.mock.calls[1][0]).toMatchObject({
        type: 'result', status: 'success', content: 'command output',
    })
})
