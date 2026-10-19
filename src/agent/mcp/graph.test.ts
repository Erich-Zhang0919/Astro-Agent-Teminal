import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import { Command, MemorySaver } from '@langchain/langgraph'
import { createAgentGraph, ToolApprovalRequest } from '../agent-graph'
import { runGraphWithApprovals } from '../agent-runner'
import { HookEngine } from '../hooks/engine'
import { createMcpTool } from './adapter'
import { requestToolApproval } from '../tool-approval'

jest.mock('../tools', () => ({ maybePersistedOutput: async (value: string) => value.length > 50_000 ? 'persisted preview' : value }))

function setup(autoApprove = false, raw = 'external result') {
    const execute = jest.fn(async () => ({ content: [{ type: 'text' as const, text: raw }] }))
    const metadata = { serverId: 'fixture', toolName: 'counter', bindingFingerprint: 'original', autoApprove, isAvailable: () => true }
    const item = createMcpTool({ name: 'counter', inputSchema: { type: 'object', properties: {} } },
        metadata, process.cwd(), execute)
    const invoke = jest.fn().mockResolvedValueOnce(new AIMessage({ content: '', tool_calls: [
        { name: item.name, args: {}, id: 'mcp-call', type: 'tool_call' },
    ] })).mockResolvedValue(new AIMessage('done'))
    const bindTools = jest.fn(() => ({ invoke }))
    const graph = createAgentGraph({ model: { bindTools } as unknown as BaseChatModel,
        tools: [], systemPrompt: 'test', checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: 'mcp-graph' }, context: { toolset: [item] } }
    return { graph, item, metadata, execute, invoke, config, bindTools }
}

it.each([true, false, undefined])('defaults to approval and respects decision %s', async decision => {
    const { graph, config, execute, bindTools, item } = setup()
    const confirm = decision === undefined ? undefined : jest.fn(async () => decision)
    await runGraphWithApprovals(graph, 'use MCP', () => undefined, config, 'test', undefined, confirm)
    expect(execute).toHaveBeenCalledTimes(decision ? 1 : 0)
    expect(bindTools).toHaveBeenCalledWith([item])
    if (confirm) expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
        mcp: { serverId: 'fixture', toolName: 'counter', bindingFingerprint: 'original' },
    }))
})

it('runs hooks for whitelisted tools and persists output after complete post-hook content', async () => {
    const { graph, config, execute, invoke } = setup(true, 'x'.repeat(60_000))
    const hooks = await HookEngine.load({ cwd: process.cwd() })
    const run = jest.spyOn(hooks, 'run').mockResolvedValue({ blocked: false, injections: [] })
    const confirm = jest.fn(async () => true)
    await runGraphWithApprovals(graph, 'use MCP', () => undefined,
        { ...config, context: { ...config.context, hooks } }, 'test', undefined, confirm)
    expect(confirm).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(run.mock.calls.map(([input]) => input.event)).toEqual(['PreToolUse', 'PostToolUse'])
    const post = run.mock.calls[1][0]
    expect(post.event === 'PostToolUse' && post.result.content).toBe('x'.repeat(60_000))
    const messages = invoke.mock.calls[1][0] as ToolMessage[]
    expect(messages.find(ToolMessage.isInstance)?.content).toBe('persisted preview')
    run.mockRestore()
})

it('allows PreToolUse to block a whitelisted tool without post hooks', async () => {
    const { graph, config, execute } = setup(true)
    const hooks = await HookEngine.load({ cwd: process.cwd() })
    const run = jest.spyOn(hooks, 'run').mockResolvedValue({ blocked: true, error: 'hook blocked', injections: [] })
    await graph.invoke({ messages: [new HumanMessage('run')] }, { ...config, context: { ...config.context, hooks } })
    expect(execute).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledTimes(1)
    run.mockRestore()
})

it('denies an old pending approval when its binding changes', async () => {
    const { graph, config, execute, metadata } = setup()
    await graph.invoke({ messages: [new HumanMessage('run')] }, config)
    metadata.bindingFingerprint = 'new-target'
    metadata.autoApprove = true
    const confirm = jest.fn(async () => true)
    await runGraphWithApprovals(graph, 'continue', () => undefined, config, 'test', undefined, confirm)
    expect(confirm).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
})

it('checks already-approved bindings at the tool checkpoint boundary', async () => {
    const { graph, config, execute, item } = setup()
    await graph.invoke({ messages: [new HumanMessage('run')] }, config)
    const request = (await graph.getState(config)).tasks[0].interrupts[0].value as ToolApprovalRequest
    await graph.updateState(config, {
        approvalDecisions: [true], blockedReasons: [null], hookBatchId: 'approved-batch',
        hookCalls: [{ name: item.name, args: {}, id: 'mcp-call', mcp: request.mcp }],
    }, 'pre_tool_hooks')
    const replacement = { ...config, context: { toolset: [] } }
    await graph.invoke(null, replacement)
    expect(execute).not.toHaveBeenCalled()
    const snapshot = await graph.getState(config)
    expect(snapshot.values.messages.filter(ToolMessage.isInstance)[0]).toMatchObject({ status: 'error' })
})

it('rejects stale bindings even when resumed directly with approval', async () => {
    const { graph, config, execute, metadata } = setup()
    await graph.invoke({ messages: [new HumanMessage('run')] }, config)
    metadata.bindingFingerprint = 'changed'
    await graph.invoke(new Command({ resume: { approved: true } }), config)
    expect(execute).not.toHaveBeenCalled()
})

it('denies MCP approval without an interactive terminal and shows its source', async () => {
    const write = jest.fn()
    expect(await requestToolApproval({ name: 'mcp__fixture__counter', args: {}, index: 1, total: 1,
        mcp: { serverId: 'fixture', toolName: 'counter', bindingFingerprint: 'original' } },
    { interactive: false, readAnswer: jest.fn(), write })).toBe(false)
    expect(write.mock.calls.map(([value]) => value).join('')).toContain('MCP Server: fixture')
})
