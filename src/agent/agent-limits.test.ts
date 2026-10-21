import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import { tool } from '@langchain/core/tools'
import { GraphRecursionError, MemorySaver } from '@langchain/langgraph'
import { z } from 'zod'
import { createAgentGraph } from './agent-graph'
import { runGraphWithApprovals } from './agent-runner'
import { MAX_TOOL_ROUNDS } from './agent-limits'
import type { HookEngine } from './hooks'

jest.mock('./tools', () => ({ maybePersistedOutput: async (content: string) => content }))

function setup(rounds = Infinity, approval = false) {
    let requests = 0
    const name = approval ? 'agent_tool' : 'tavily_search'
    const bound = jest.fn(async (_messages: BaseMessage[]) => {
        requests++
        return requests <= rounds ? new AIMessage({ content: '', tool_calls: [{
            name, id: `call_${requests}`, args: { query: `query ${requests}` }, type: 'tool_call',
        }] }) : new AIMessage('answer')
    })
    const final = jest.fn(async (_messages: BaseMessage[]) => new AIMessage('summary from available results'))
    const execute = jest.fn(async () => 'search result')
    const search = Object.assign(tool(execute, { name, schema: z.object({ query: z.string() }) }), {
        permission_level: approval ? 'exec' : 'network',
    })
    const model = { bindTools: () => ({ invoke: bound }), invoke: final } as unknown as BaseChatModel
    const graph = createAgentGraph({ model, tools: [search], systemPrompt: 'test', checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: 'budget-test' } }
    const tokens: string[] = []
    const onToken = (token: string) => { tokens.push(token) }
    return { graph, config, bound, final, execute, tokens, onToken }
}

it('completes five search rounds and streams the answer beyond the former 25-step limit', async () => {
    const { graph, config, execute, bound, final, tokens, onToken } = setup(5)
    const result = await runGraphWithApprovals(graph, 'NBA最近几场比赛', onToken, config, 'model')
    expect(execute).toHaveBeenCalledTimes(5)
    expect(bound).toHaveBeenCalledTimes(6)
    expect(final).not.toHaveBeenCalled()
    expect(result.text).toBe('answer')
    expect(tokens.join('')).toBe('answer')
    expect((await graph.getState(config)).next).toEqual([])
})

it('finishes with tools disabled at the turn budget even when hooks inject human messages', async () => {
    const { graph, config, execute, bound, final, tokens, onToken } = setup()
    const run = jest.fn(async () => ({ blocked: false, injections: ['hook context'] }))
    const context = { hooks: { cwd: process.cwd(), run } as unknown as HookEngine }
    const result = await runGraphWithApprovals(graph, 'search', onToken, { ...config, context }, 'model')
    expect(execute).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS)
    expect(bound).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS)
    expect(final).toHaveBeenCalledTimes(1)
    expect(final.mock.calls[0][0].filter(ToolMessage.isInstance)).toHaveLength(MAX_TOOL_ROUNDS)
    expect(final.mock.calls[0][0].at(-1)?.content).toContain('Make no further tool calls')
    expect(result.text).toBe('summary from available results')
    expect(tokens.join('')).toBe(result.text)
    expect((await graph.getState(config)).next).toEqual([])

    bound.mockResolvedValueOnce(new AIMessage('new answer'))
    const next = await runGraphWithApprovals(graph, 'new question', () => undefined, config, 'model')
    expect(next.text).toBe('new answer')
    expect(final).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS)
})

it('keeps the same turn budget across approval interrupts', async () => {
    const { graph, config, execute, final, onToken } = setup(Infinity, true)
    const confirm = jest.fn(async () => true)
    await runGraphWithApprovals(graph, 'run', onToken, config, 'model', undefined, confirm)
    expect(confirm).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS)
    expect(execute).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS)
    expect(final).toHaveBeenCalledTimes(1)
    expect((await graph.getState(config)).next).toEqual([])
})

it.each(['empty', 'tool call'])('ends cleanly if the final model returns %s', async mode => {
    const { graph, config, execute, final, onToken } = setup()
    final.mockResolvedValueOnce(mode === 'empty' ? new AIMessage('') : new AIMessage({
        content: '', tool_calls: [{ name: 'tavily_search', id: 'ignored', args: { query: 'again' } }],
    }))
    const result = await runGraphWithApprovals(graph, 'search', onToken, config, 'model')
    expect(execute).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS)
    expect(result.text).toContain('已停止继续调用工具')
    const state = await graph.getState(config)
    expect(state.next).toEqual([])
    expect((state.values.messages.at(-1) as AIMessage).tool_calls).toEqual([])
})

it('recovers from a hard step limit and closes unexecuted calls before a final answer', async () => {
    const { graph, config, execute, final, onToken } = setup()
    const result = await runGraphWithApprovals(graph, 'search', onToken, { ...config, recursionLimit: 25 }, 'model')
    expect(execute).toHaveBeenCalledTimes(4)
    expect(final).toHaveBeenCalledTimes(1)
    const results = final.mock.calls[0][0].filter(ToolMessage.isInstance)
    expect(results).toHaveLength(5)
    expect(results.at(-1)).toMatchObject({ tool_call_id: 'call_5', status: 'error' })
    expect(result.text).toBe('summary from available results')
    expect((await graph.getState(config)).next).toEqual([])
})

it('preserves completed tool output and post hooks when the step limit hits after execution', async () => {
    const { graph, config, execute, final, onToken } = setup()
    const run = jest.fn(async () => ({ blocked: false, injections: [] }))
    const context = { hooks: { cwd: process.cwd(), run } as unknown as HookEngine }
    await runGraphWithApprovals(graph, 'search', onToken, { ...config, context, recursionLimit: 5 }, 'model')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(run.mock.calls).toHaveLength(2)
    expect(final.mock.calls[0][0].filter(ToolMessage.isInstance)).toHaveLength(1)
    expect(final.mock.calls[0][0].filter(ToolMessage.isInstance)[0]).toMatchObject({
        status: 'success', content: 'search result',
    })
    expect((await graph.getState(config)).next).toEqual([])
})

it('does not execute a stale unreviewed search when a new question follows a legacy limit error', async () => {
    const { graph, config, execute, bound, final } = setup()
    await expect(graph.invoke({ messages: [new HumanMessage('old question')] },
        { ...config, recursionLimit: 25 })).rejects.toBeInstanceOf(GraphRecursionError)
    expect((await graph.getState(config)).next).toEqual(['prepare_tools'])
    expect(execute).toHaveBeenCalledTimes(4)

    bound.mockResolvedValueOnce(new AIMessage('new answer'))
    const result = await runGraphWithApprovals(graph, 'new question', () => undefined, config, 'model')
    expect(execute).toHaveBeenCalledTimes(4)
    expect(final).toHaveBeenCalledTimes(1)
    expect(result.text).toContain('new answer')
    expect((await graph.getState(config)).next).toEqual([])
})

it('preserves unrelated model failures', async () => {
    const { graph, config, bound, final } = setup()
    bound.mockRejectedValueOnce(new Error('model unavailable'))
    await expect(runGraphWithApprovals(graph, 'search', () => undefined, config, 'model'))
        .rejects.toThrow('model unavailable')
    expect(final).not.toHaveBeenCalled()
})
