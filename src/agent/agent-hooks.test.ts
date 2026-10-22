import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import { tool } from '@langchain/core/tools'
import { Command, MemorySaver, StateGraph, StateSchema, MessagesValue, START, END } from '@langchain/langgraph'
import { z } from 'zod'
import { createAgentGraph } from './agent-graph'
import { runGraphWithApprovals } from './agent-runner'
import { HookEngine, HookInput } from './hooks'
import { withPermissionLevel } from './permission/util'
import { maybePersistedOutput } from './tools'

jest.mock('./tools', () => ({ maybePersistedOutput: jest.fn(async (content: string) => content) }))

async function setup(approval = false, output = 'result') {
    const first = jest.fn(async () => output)
    const second = jest.fn(async () => 'second result')
    const calls = [
        { name: 'first_exec', id: 'call_1', args: { command: 'true' }, type: 'tool_call' as const },
        { name: 'second_exec', id: 'call_2', args: { command: 'true' }, type: 'tool_call' as const },
    ]
    const invoke = jest.fn()
        .mockResolvedValueOnce(new AIMessage({ content: '', tool_calls: calls }))
        .mockResolvedValue(new AIMessage('done'))
    const model = { bindTools: () => ({ invoke }) } as unknown as BaseChatModel
    const tools = [first, second].map((execute, index) => {
        const item = tool(execute, { name: calls[index].name, schema: z.object({ command: z.string() }) })
        return approval ? withPermissionLevel(item, 'exec') : item
    })
    const checkpointer = new MemorySaver()
    const graph = createAgentGraph({ model, tools, systemPrompt: 'test', checkpointer })
    const hooks = await HookEngine.load({ cwd: process.cwd(), hooksPath: 'scripts/hooks.example.json' })
    const run = jest.spyOn(hooks, 'run').mockResolvedValue({ blocked: false, injections: [] })
    const config = { configurable: { thread_id: 'hooks' }, context: { hooks } }
    return { first, second, calls, invoke, graph, hooks, run, config, model, tools, checkpointer }
}

beforeEach(() => jest.mocked(maybePersistedOutput).mockImplementation(async content => content))

it('executes configured scripts and reports pre/post hooks around auto-approved tools', async () => {
    const { graph, first, second, config } = await setup()
    const events: string[] = []
    const hooks = await HookEngine.load({ cwd: process.cwd(), hooksPath: 'scripts/hooks.example.json',
        onHookEvent: notice => { events.push(notice.event) } })
    first.mockImplementation(async () => { events.push('first tool'); return 'first result' })
    second.mockImplementation(async () => { events.push('second tool'); return 'second result' })
    await graph.invoke({ messages: [new HumanMessage('run')] },
        { ...config, context: { hooks } })
    expect(events).toEqual([
        'PreToolUse', 'PreToolUse', 'first tool', 'second tool', 'PostToolUse', 'PostToolUse',
    ])
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
})

it('runs hooks only after approval and skips user-rejected calls', async () => {
    const { graph, run, first, second, config } = await setup(true)
    await graph.invoke({ messages: [new HumanMessage('run')] }, config)
    expect(run).not.toHaveBeenCalled()
    await graph.invoke(new Command({ resume: { approved: false } }), config)
    expect(run).not.toHaveBeenCalled()
    await graph.invoke(new Command({ resume: { approved: true } }), config)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    expect(run.mock.calls.map(([input]) => [input.event, 'tool' in input && input.tool.name]))
        .toEqual([['PreToolUse', 'second_exec'], ['PostToolUse', 'second_exec']])
})

it('blocks one approved tool and preserves ordered results for the rest of the batch', async () => {
    const { graph, run, first, second, config, invoke } = await setup()
    run.mockImplementation(async input => input.event === 'PreToolUse' && input.tool.name === 'first_exec'
        ? { blocked: true, error: 'hook denied\n', injections: [] }
        : { blocked: false, injections: [] })
    await graph.invoke({ messages: [new HumanMessage('run')] }, config)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    const messages = invoke.mock.calls[1][0] as BaseMessage[]
    expect(messages.filter(ToolMessage.isInstance).map(message =>
        [message.tool_call_id, message.status, message.content]))
        .toEqual([['call_1', 'error', 'hook denied\n'], ['call_2', 'success', 'second result']])
    expect(run.mock.calls.filter(([input]) => input.event === 'PostToolUse')).toHaveLength(1)
})

it('injects pre/post context after complete tool results without streaming hook text', async () => {
    const { graph, run, config, invoke } = await setup()
    run.mockImplementation(async input => ({ blocked: false,
        injections: [`${input.event}:${'tool' in input && input.tool.name}`] }))
    const tokens: string[] = []
    const result = await runGraphWithApprovals(graph, 'run', token => tokens.push(token), config, 'model')
    expect(result.text).toBe('done')
    expect(tokens.join('')).toBe('done')
    const messages = (invoke.mock.calls[1][0] as BaseMessage[]).slice(1)
    expect(messages.map(message => message.getType())).toEqual([
        'human', 'ai', 'tool', 'tool', 'human', 'human', 'human', 'human',
    ])
    const injections = messages.filter(message => message.id?.startsWith('hook:'))
    expect(injections.map(message => message.content)).toEqual([
        '[Hook context: PreToolUse]\nPreToolUse:first_exec',
        '[Hook context: PreToolUse]\nPreToolUse:second_exec',
        '[Hook context: PostToolUse]\nPostToolUse:first_exec',
        '[Hook context: PostToolUse]\nPostToolUse:second_exec',
    ])
})

it('passes raw success/error outputs to post hooks before persisting previews', async () => {
    const raw = 'x'.repeat(60_000)
    const { graph, run, second, config, invoke } = await setup(false, raw)
    second.mockRejectedValueOnce(new Error('tool failed'))
    jest.mocked(maybePersistedOutput).mockImplementation(async content =>
        content.length > 50_000 ? 'persisted preview' : content)
    await graph.invoke({ messages: [new HumanMessage('run')] }, config)
    const posts = run.mock.calls.map(([input]) => input)
        .filter((input): input is Extract<HookInput, { event: 'PostToolUse' }> =>
            input.event === 'PostToolUse')
    expect(posts[0].result).toEqual({ status: 'success', content: raw })
    expect(posts[1].result.status).toBe('error')
    expect(posts[1].result.content).toContain('tool failed')
    expect((invoke.mock.calls[1][0] as BaseMessage[]).filter(ToolMessage.isInstance)[0].content)
        .toBe('persisted preview')
})

it('resumes cancelled post processing without repeating pre hooks or tools', async () => {
    const { graph, run, first, second, config, model, tools, checkpointer } = await setup()
    const onToolEvent = jest.fn()
    const observedConfig = { ...config, context: { ...config.context, onToolEvent } }
    const controller = new AbortController()
    let cancel = true
    run.mockImplementation(async input => {
        if (input.event === 'PostToolUse' && cancel) {
            cancel = false
            controller.abort()
            throw new Error('cancelled post hook')
        }
        return { blocked: false, injections: [] }
    })
    await expect(graph.invoke({ messages: [new HumanMessage('run')] },
        { ...observedConfig, signal: controller.signal })).rejects.toThrow()
    const snapshot = await graph.getState(config)
    expect(snapshot.next).toContain('post_tool_hooks')
    const restored = createAgentGraph({ model, tools, systemPrompt: 'test', checkpointer })
    await runGraphWithApprovals(restored, 'next input', () => undefined, observedConfig, 'model')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(run.mock.calls.filter(([input]) => input.event === 'PreToolUse')).toHaveLength(2)
    const posts = run.mock.calls.filter(([input]) => input.event === 'PostToolUse')
    expect(posts).toHaveLength(3)
    expect(posts[0][0].eventId).toBe(posts[1][0].eventId)
    expect(onToolEvent).toHaveBeenCalledTimes(4)
})

it('reports hook-blocked calls without claiming they started execution', async () => {
    const { graph, run, first, config } = await setup()
    const onToolEvent = jest.fn()
    run.mockImplementation(async input => input.event === 'PreToolUse' && input.tool.name === 'first_exec'
        ? { blocked: true, error: 'hook denied', injections: [] }
        : { blocked: false, injections: [] })
    await graph.invoke({ messages: [new HumanMessage('run')] },
        { ...config, context: { ...config.context, onToolEvent } })
    expect(first).not.toHaveBeenCalled()
    expect(onToolEvent.mock.calls.filter(([event]) => event.name === 'first_exec')).toEqual([
        [expect.objectContaining({ type: 'result', status: 'blocked', content: 'hook denied',
            reason: { source: 'hook', code: 'hook_blocked', message: 'hook denied' } })],
    ])
})

it('deduplicates lifecycle inbox messages after checkpointing', async () => {
    const { graph, config, invoke } = await setup()
    const hookMessages = () => [{ id: 'hook:lifecycle', event: 'SessionStart' as const, text: 'startup' }]
    await graph.invoke({ messages: [new HumanMessage('run')] },
        { ...config, context: { ...config.context, hookMessages } })
    await graph.invoke({ messages: [new HumanMessage('next')] },
        { ...config, context: { ...config.context, hookMessages } })
    const finalHistory = (invoke.mock.calls[2][0] as BaseMessage[])
    expect(finalHistory.filter(message => message.id === 'hook:lifecycle')).toHaveLength(1)
})

it('preserves Command updates and runs post hooks on their tool messages', async () => {
    const hooks = await HookEngine.load({ cwd: process.cwd(), hooksPath: 'scripts/hooks.example.json' })
    const run = jest.spyOn(hooks, 'run').mockResolvedValue({ blocked: false, injections: ['command context'] })
    const execute = jest.fn(async () => new Command({ update: {
        messages: [new ToolMessage({ tool_call_id: 'command_call', content: 'command result' })],
    } }))
    const invoke = jest.fn()
        .mockResolvedValueOnce(new AIMessage({ content: '', tool_calls: [
            { name: 'command_tool', id: 'command_call', args: {}, type: 'tool_call' },
        ] }))
        .mockResolvedValue(new AIMessage('done'))
    const graph = createAgentGraph({
        model: { bindTools: () => ({ invoke }) } as unknown as BaseChatModel,
        tools: [tool(execute, { name: 'command_tool', schema: z.object({}) })],
        systemPrompt: 'test', checkpointer: new MemorySaver(),
    })
    await graph.invoke({ messages: [new HumanMessage('run')] },
        { configurable: { thread_id: 'command' }, context: { hooks } })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(run.mock.calls.map(([input]) => input.event)).toEqual(['PreToolUse', 'PostToolUse'])
    expect((invoke.mock.calls[1][0] as BaseMessage[]).filter(ToolMessage.isInstance)[0].content)
        .toBe('command result')
})

it('migrates a legacy checkpoint awaiting tool execution through pre hooks', async () => {
    const { graph, run, first, second, config, calls, checkpointer, invoke } = await setup()
    const LegacyState = new StateSchema({
        messages: MessagesValue,
        approvalDecisions: z.array(z.boolean()).default([]),
        blockedReasons: z.array(z.string().nullable()).default([]),
    })
    const legacy = new StateGraph(LegacyState)
        .addNode('review_tools', () => ({
            messages: [new AIMessage({ content: '', tool_calls: calls })],
            approvalDecisions: [true, true], blockedReasons: [null, null],
        }))
        .addNode('tools', () => ({}))
        .addEdge(START, 'review_tools').addEdge('review_tools', 'tools').addEdge('tools', END)
        .compile({ checkpointer, interruptAfter: ['review_tools'] })
    await legacy.invoke({ messages: [new HumanMessage('old input')] }, config)
    expect((await legacy.getState(config)).next).toEqual(['tools'])
    invoke.mockReset().mockResolvedValue(new AIMessage('done'))
    await runGraphWithApprovals(graph, 'new input', () => undefined, config, 'model')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(run.mock.calls.filter(([input]) => input.event === 'PreToolUse')).toHaveLength(2)
})

it('uses different event IDs when tool call IDs are reused in a later turn', async () => {
    const { graph, run, first, config, invoke, calls } = await setup()
    await graph.invoke({ messages: [new HumanMessage('first turn')] }, config)
    invoke.mockResolvedValueOnce(new AIMessage({ content: '', tool_calls: calls }))
    await graph.invoke({ messages: [new HumanMessage('second turn')] }, config)
    expect(first).toHaveBeenCalledTimes(2)
    const pres = run.mock.calls.filter(([input]) => input.event === 'PreToolUse')
    expect(pres[0][0].eventId).not.toBe(pres[2][0].eventId)
})

it('does not execute tools if a pre hook is cancelled', async () => {
    const { graph, run, first, second, config } = await setup()
    const controller = new AbortController()
    run.mockImplementationOnce(async () => {
        controller.abort()
        throw new Error('cancelled pre hook')
    })
    await expect(graph.invoke({ messages: [new HumanMessage('run')] },
        { ...config, signal: controller.signal })).rejects.toThrow()
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    await runGraphWithApprovals(graph, 'next turn', () => undefined, config, 'model')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][0].eventId).toBe(run.mock.calls[1][0].eventId)
})

it('preserves tuple Command updates between hook-blocked tool results in call order', async () => {
    const hooks = await HookEngine.load({ cwd: process.cwd(), hooksPath: 'scripts/hooks.example.json' })
    const run = jest.spyOn(hooks, 'run').mockImplementation(async input =>
        input.event === 'PreToolUse' && input.tool.name !== 'command_tool'
            ? { blocked: true, error: 'denied', injections: [] }
            : { blocked: false, injections: [] })
    const unused = jest.fn(async () => 'should not execute')
    const execute = jest.fn(async () => new Command({ goto: 'model_request', update: [
        ['messages', [new ToolMessage({ tool_call_id: 'call_1', content: 'command result' })]],
    ] }))
    const names = ['blocked_first', 'command_tool', 'blocked_last']
    const invoke = jest.fn()
        .mockResolvedValueOnce(new AIMessage({ content: '', tool_calls: names.map((name, index) => ({
            name, id: `call_${index}`, args: {}, type: 'tool_call' as const,
        })) }))
        .mockResolvedValue(new AIMessage('done'))
    const graph = createAgentGraph({
        model: { bindTools: () => ({ invoke }) } as unknown as BaseChatModel,
        tools: names.map(name => tool(name === 'command_tool' ? execute : unused,
            { name, schema: z.object({}) })),
        systemPrompt: 'test', checkpointer: new MemorySaver(),
    })
    await graph.invoke({ messages: [new HumanMessage('run')] },
        { configurable: { thread_id: 'mixed-command' }, context: { hooks } })
    expect(unused).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect((invoke.mock.calls[1][0] as BaseMessage[]).filter(ToolMessage.isInstance)
        .map(message => [message.tool_call_id, message.content])).toEqual([
        ['call_0', 'denied'], ['call_1', 'command result'], ['call_2', 'denied'],
    ])
    expect(run.mock.calls.filter(([input]) => input.event === 'PostToolUse')).toHaveLength(1)
})
