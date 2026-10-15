import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import type { BaseChatModelCallOptions } from '@langchain/core/language_models/chat_models'
import type { AgentGraphContext } from './agent-graph'
import type { HookInput } from './hooks/engine'

interface ModelOptions extends BaseChatModelCallOptions {
    testTools: { name: string }[]
    configurable: { thread_id: string; [key: string]: unknown }
    context: AgentGraphContext
}

const mockRespond = jest.fn<Promise<AIMessage>, [BaseMessage[], ModelOptions]>()

// Use a real LangChain model wrapper so nested callback/stream propagation is exercised.
jest.mock('@langchain/openai', () => {
    const { BaseChatModel } = require('@langchain/core/language_models/chat_models')
    return { ChatOpenAI: class extends BaseChatModel {
        constructor() { super({}) }
        _llmType() { return 'scripted-test-model' }
        bindTools(testTools: { name: string }[]) { return this.withConfig({ testTools }) }
        async _generate(messages: BaseMessage[], options: ModelOptions) {
            const { AsyncLocalStorageProviderSingleton } = require('@langchain/core/singletons')
            const message = await mockRespond(messages, {
                ...AsyncLocalStorageProviderSingleton.getRunnableConfig(), ...options,
            })
            return { generations: [{ text: typeof message.content === 'string' ? message.content : '', message }] }
        }
    } }
})

jest.mock('./db', () => {
    const { SqliteSaver } = require('@langchain/langgraph-checkpoint-sqlite')
    const checkpointer = SqliteSaver.fromConnString(':memory:')
    const db = checkpointer.db
    db.exec(`CREATE TABLE memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, content TEXT, keywords TEXT,
        importance INTEGER, session_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`)
    return { checkpointer, db }
})
jest.mock('./model-metadata', () => ({ getModelContextWindow: jest.fn(async () => 100_000) }))
jest.mock('./tools/web_search', () => {
    const { tool } = require('@langchain/core/tools')
    const { z } = require('zod')
    return { webSearchTool: tool(async () => 'unused test search', {
        name: 'tavily_search', schema: z.object({ query: z.string() }),
    }) }
})

import { MemorySaver } from '@langchain/langgraph'
import { agent, contextCompactionStore, endAgentSession, runAgentStream, startAgentSession } from './agent'
import { checkpointer, db } from './db'
import { HookEngine } from './hooks/engine'
import { MemoryHookContextStore } from './hooks/context-store'
import { delegationPrompt, systemPrompt } from './prompt'
import { tools } from './tools'
import * as toolRegistry from './tools'

const parents = new Set<string>()
let parentCounter = 0
let hookRun: jest.SpyInstance
let deleteThread: jest.SpyInstance

function parentId() {
    const id = `parent-${++parentCounter}`
    parents.add(id)
    return id
}

function child(options: ModelOptions) { return options.configurable.thread_id.startsWith('subagent-') }
function results(messages: BaseMessage[]) { return messages.filter(ToolMessage.isInstance) }
function call(name: string, args: Record<string, unknown>, content = '') {
    return new AIMessage({ content, tool_calls: [{ name, args, id: `call-${name}`, type: 'tool_call' }] })
}
function delegate(prompt = 'Independent task') { return call('agent_tool', { prompt }, 'Delegating. ') }

beforeEach(() => {
    mockRespond.mockReset()
    hookRun = jest.spyOn(HookEngine.prototype, 'run').mockImplementation(async input => ({
        blocked: false,
        injections: input.event === 'SessionStart' ? [`startup:${input.sessionId}`] : [],
    }))
    deleteThread = jest.spyOn(MemorySaver.prototype, 'deleteThread')
    jest.spyOn(contextCompactionStore, 'get').mockResolvedValue(undefined)
})

afterEach(async () => {
    for (const id of parents) await endAgentSession(id, 'exit')
    parents.clear()
    jest.restoreAllMocks()
    db.exec('DELETE FROM memory; DELETE FROM hook_context')
})

afterAll(() => db.close())

it('isolates child input/tools/configuration and returns only the final answer before the parent continues', async () => {
    const id = parentId()
    const approve = jest.fn(async () => true)
    const preprocessMessages = jest.fn((messages: readonly BaseMessage[]) => [...messages,
        new HumanMessage('parent-only preprocessing')])
    const onToolEvent = jest.fn()
    const onHookEvent = jest.fn()
    const onHookDiagnostic = jest.fn()
    const loadHooks = jest.spyOn(HookEngine, 'load')
    const clearInbox = jest.spyOn(MemoryHookContextStore.prototype, 'clear')
    let childId = ''
    mockRespond.mockImplementation(async (messages, options) => {
        if (!child(options)) {
            expect(messages[0].content).toContain(delegationPrompt)
            if (!results(messages).length) return delegate('Inspect independently')
            expect(results(messages).at(-1)).toMatchObject({ content: 'CHILD FINAL', status: 'success' })
            return new AIMessage({ content: 'PARENT FINAL', usage_metadata: {
                input_tokens: 10, output_tokens: 5, total_tokens: 15,
            } })
        }
        childId = options.configurable.thread_id
        expect(messages[0].content).toBe(systemPrompt)
        expect(messages.filter(message => message.getType() === 'human').map(message => message.content))
            .toEqual(['Inspect independently', `[Hook context: SessionStart]\nstartup:${childId}`])
        expect(options.testTools.map(tool => tool.name)).toEqual(tools.filter(tool => tool.name !== 'agent_tool')
            .map(tool => tool.name))
        expect(options.context.runSubAgent).toBeUndefined()
        expect(options.context.preprocessMessages).toBeUndefined()
        expect(options.context.onToolEvent).toBe(onToolEvent)
        expect(options.configurable.checkpoint_ns).toMatch(/^model_request:[^|]+$/)
        expect(options.signal).toBeDefined()
        const count = results(messages).length
        if (!count) return call('load_skill', { name: 'planner' }, 'CHILD INTERMEDIATE')
        if (count === 1) {
            expect(results(messages)[0].content).toContain('name: planner')
            return call('memory_create_tool', { type: 'fact', content: 'independent fact' })
        }
        expect(results(messages)[1].content).toContain('Memory created successfully')
        return new AIMessage({ content: 'CHILD FINAL', usage_metadata: {
            input_tokens: 1000, output_tokens: 500, total_tokens: 1500,
        } })
    })
    const tokens: string[] = []
    const controller = new AbortController()
    const result = await runAgentStream('PARENT SECRET', token => tokens.push(token), id, controller.signal,
        { confirmTool: approve, preprocessMessages, onToolEvent, onHookEvent, onHookDiagnostic,
            hooksPath: 'src/agent/hooks/hooks.json' })
    expect(result.text).toBe('Delegating. PARENT FINAL')
    expect(tokens.join('')).toBe(result.text)
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    expect(approve).toHaveBeenCalledTimes(1)
    expect(preprocessMessages).toHaveBeenCalledTimes(2)
    expect(contextCompactionStore.get).toHaveBeenCalledTimes(1)
    expect(contextCompactionStore.get).toHaveBeenCalledWith(id)
    expect(loadHooks).toHaveBeenCalledWith(expect.objectContaining({
        hooksPath: 'src/agent/hooks/hooks.json', onHookEvent, onDiagnostic: onHookDiagnostic,
    }))
    const childEvents = hookRun.mock.calls.map(([input]) => input as HookInput)
        .filter(input => input.sessionId === childId)
    expect(childEvents.map(input => input.event)).toEqual([
        'SessionStart', 'PreToolUse', 'PostToolUse', 'PreToolUse', 'PostToolUse', 'SessionEnd',
    ])
    expect(childEvents.at(-1)).toMatchObject({ reason: 'ask_completed' })
    expect(onToolEvent.mock.calls.map(([event]) => [event.type, event.name])).toContainEqual(['start', 'load_skill'])
    expect(db.prepare('SELECT session_id FROM memory').all()).toEqual([{ session_id: childId }])
    expect(await checkpointer.getTuple({ configurable: { thread_id: childId } })).toBeUndefined()
    expect(db.prepare('SELECT * FROM hook_context WHERE session_id = ?').all(childId)).toEqual([])
    const parentSnapshot = await agent.getState({ configurable: { thread_id: id } })
    expect(parentSnapshot.values.messages.map((message: BaseMessage) => message.content).join('\n'))
        .not.toContain('CHILD INTERMEDIATE')
    expect(clearInbox).toHaveBeenCalledTimes(1)
    expect(deleteThread).toHaveBeenCalledWith(childId)
})

it('routes child tool approval through the parent callback and preserves per-tool policy', async () => {
    const approve = jest.fn(async request => request.name !== 'exec')
    mockRespond.mockImplementation(async (messages, options) => {
        if (!child(options)) return results(messages).length ? new AIMessage('parent done') : delegate()
        if (!results(messages).length) return call('exec', { command: 'true' })
        expect(results(messages)[0]).toMatchObject({ status: 'error' })
        return new AIMessage('child handled denial')
    })
    await runAgentStream('task', () => undefined, parentId(), undefined, { confirmTool: approve })
    expect(approve.mock.calls.map(([request]) => request.name)).toEqual(['agent_tool', 'exec'])
})

it.each(['throw', 'empty', 'blocked-start'])('returns a child %s failure and lets the parent continue', async failure => {
    let childId = ''
    if (failure === 'blocked-start') hookRun.mockImplementation(async (input: HookInput) => {
        if (input.event === 'SessionStart' && input.sessionId.startsWith('subagent-')) {
            childId = input.sessionId
            return { blocked: true, error: 'startup denied', injections: [] }
        }
        return { blocked: false, injections: [] }
    })
    mockRespond.mockImplementation(async (messages, options) => {
        if (child(options)) {
            childId = options.configurable.thread_id
            if (failure === 'throw') throw new Error('child model failed')
            return new AIMessage(' \n')
        }
        if (!results(messages).length) return delegate()
        expect(results(messages)[0]).toMatchObject({ status: 'error' })
        expect(String(results(messages)[0].content)).toContain(
            failure === 'throw' ? 'child model failed' : failure === 'empty' ? 'empty final response' : 'startup denied')
        return new AIMessage('parent recovered')
    })
    const result = await runAgentStream('task', () => undefined, parentId(), undefined, { confirmTool: async () => true })
    expect(result.text).toContain('parent recovered')
    expect(deleteThread).toHaveBeenCalledWith(childId)
    const endings = hookRun.mock.calls.map(([input]) => input as HookInput)
        .filter(input => input.sessionId === childId && input.event === 'SessionEnd')
    expect(endings).toHaveLength(failure === 'blocked-start' ? 0 : 1)
    if (failure !== 'blocked-start') expect(endings[0]).toMatchObject({ reason: 'error' })
})

it('cancels a running child, closes its lifecycle, and does not resume the parent model', async () => {
    const controller = new AbortController()
    let childId = ''
    mockRespond.mockImplementation(async (_messages, options) => {
        if (!child(options)) return delegate()
        childId = options.configurable.thread_id
        controller.abort(new Error('cancel running child'))
        options.signal?.throwIfAborted()
        return new AIMessage('unreachable')
    })
    await expect(runAgentStream('task', () => undefined, parentId(), controller.signal,
        { confirmTool: async () => true })).rejects.toThrow()
    expect(mockRespond.mock.calls.filter(([, options]) => !child(options))).toHaveLength(1)
    expect(hookRun.mock.calls.map(([input]) => input as HookInput)).toContainEqual(expect.objectContaining({
        sessionId: childId, event: 'SessionEnd', reason: 'error',
    }))
    expect(deleteThread).toHaveBeenCalledWith(childId)
})

it('rejects a hallucinated nested agent_tool call without starting a grandchild', async () => {
    mockRespond.mockImplementation(async (messages, options) => {
        if (!results(messages).length) return delegate(child(options) ? 'nested task' : 'child task')
        if (child(options)) expect(results(messages)[0]).toMatchObject({ status: 'error' })
        return new AIMessage(child(options) ? 'child done' : 'parent done')
    })
    await runAgentStream('task', () => undefined, parentId(), undefined, { confirmTool: async () => true })
    expect(hookRun.mock.calls.map(([input]) => input as HookInput)
        .filter(input => input.event === 'SessionStart' && input.sessionId.startsWith('subagent-'))).toHaveLength(1)
})

it('runs multiple delegate calls sequentially and continues the queue after a child fails', async () => {
    mockRespond.mockImplementation(async (messages, options) => {
        if (child(options)) {
            if (messages[1].content === 'first') throw new Error('first child failed')
            return new AIMessage('second child succeeded')
        }
        if (!results(messages).length) return new AIMessage({ content: '', tool_calls: [
            { name: 'agent_tool', id: 'first', args: { prompt: 'first' }, type: 'tool_call' },
            { name: 'agent_tool', id: 'second', args: { prompt: 'second' }, type: 'tool_call' },
        ] })
        expect(results(messages)).toMatchObject([
            { tool_call_id: 'first', status: 'error' },
            { tool_call_id: 'second', content: 'second child succeeded', status: 'success' },
        ])
        return new AIMessage('parent done')
    })
    await runAgentStream('task', () => undefined, parentId(), undefined, { confirmTool: async () => true })
    const lifecycle = hookRun.mock.calls.map(([input]) => input as HookInput)
        .filter(input => input.sessionId.startsWith('subagent-') &&
            (input.event === 'SessionStart' || input.event === 'SessionEnd'))
    expect(lifecycle.map(input => input.event)).toEqual(['SessionStart', 'SessionEnd', 'SessionStart', 'SessionEnd'])
    expect(lifecycle[0].sessionId).toBe(lifecycle[1].sessionId)
    expect(lifecycle[2].sessionId).toBe(lifecycle[3].sessionId)
    expect(lifecycle[0].sessionId).not.toBe(lifecycle[2].sessionId)
    expect(deleteThread).toHaveBeenCalledTimes(2)
})

it('inherits the active hook configuration even when the current turn omits hook options', async () => {
    const id = parentId()
    const load = jest.spyOn(HookEngine, 'load')
    const onHookEvent = jest.fn()
    await startAgentSession(id, { hooksPath: 'src/agent/hooks/hooks.json', onHookEvent })
    mockRespond.mockImplementation(async (messages, options) => {
        if (child(options)) return new AIMessage('child done')
        return results(messages).length ? new AIMessage('parent done') : delegate()
    })
    await runAgentStream('task', () => undefined, id, undefined, { confirmTool: async () => true })
    expect(load).toHaveBeenCalledTimes(1)
    const childStart = hookRun.mock.calls.find(([input]) =>
        input.event === 'SessionStart' && input.sessionId.startsWith('subagent-'))
    expect(childStart).toBeDefined()
    const parentStartIndex = hookRun.mock.calls.findIndex(([input]) => input.sessionId === id)
    const childStartIndex = hookRun.mock.calls.indexOf(childStart!)
    expect(hookRun.mock.instances[childStartIndex]).toBe(hookRun.mock.instances[parentStartIndex])
})

it('extracts text blocks from the final response', async () => {
    mockRespond.mockImplementation(async (messages, options) => {
        if (child(options)) return new AIMessage({ content: [
            { type: 'text', text: 'first ' }, { type: 'text', text: 'second' },
        ] })
        if (!results(messages).length) return delegate()
        expect(results(messages)[0].content).toBe('first second')
        return new AIMessage('parent done')
    })
    await runAgentStream('task', () => undefined, parentId(), undefined, { confirmTool: async () => true })
})

it('passes a long final result to the parent tool post hook before persisting its preview', async () => {
    const raw = 'x'.repeat(50_001)
    const persist = jest.spyOn(toolRegistry, 'maybePersistedOutput')
        .mockImplementation(async content => content.length > 50_000 ? 'persisted child preview' : content)
    mockRespond.mockImplementation(async (messages, options) => {
        if (child(options)) return new AIMessage(raw)
        if (!results(messages).length) return delegate()
        expect(results(messages)[0].content).toBe('persisted child preview')
        return new AIMessage('parent done')
    })
    await runAgentStream('task', () => undefined, parentId(), undefined, { confirmTool: async () => true })
    expect(hookRun.mock.calls.map(([input]) => input as HookInput)).toContainEqual(expect.objectContaining({
        event: 'PostToolUse', tool: expect.objectContaining({ name: 'agent_tool' }),
        result: { status: 'success', content: raw },
    }))
    expect(persist).toHaveBeenCalledWith(raw, 'call-agent_tool')
})

it('cleans up the child even if its end hook fails', async () => {
    const clear = jest.spyOn(MemoryHookContextStore.prototype, 'clear')
    hookRun.mockImplementation(async (input: HookInput) => {
        if (input.event === 'SessionEnd' && input.sessionId.startsWith('subagent-')) throw new Error('end hook failed')
        return { blocked: false, injections: [] }
    })
    mockRespond.mockImplementation(async (messages, options) => {
        if (child(options)) return new AIMessage('child done')
        if (!results(messages).length) return delegate()
        expect(results(messages)[0]).toMatchObject({ status: 'error' })
        expect(String(results(messages)[0].content)).toContain('end hook failed')
        return new AIMessage('parent recovered')
    })
    await runAgentStream('task', () => undefined, parentId(), undefined, { confirmTool: async () => true })
    expect(clear).toHaveBeenCalledTimes(1)
    expect(deleteThread).toHaveBeenCalledTimes(1)
})

it('cancels while awaiting a child tool approval without returning a partial result', async () => {
    const controller = new AbortController()
    mockRespond.mockImplementation(async (_messages, options) => child(options)
        ? call('exec', { command: 'true' }, 'partial child text') : delegate())
    await expect(runAgentStream('task', () => undefined, parentId(), controller.signal, {
        confirmTool: async request => {
            if (request.name === 'exec') controller.abort(new Error('cancel approval'))
            return true
        },
    })).rejects.toThrow()
    expect(mockRespond.mock.calls.filter(([, options]) => !child(options))).toHaveLength(1)
    expect(deleteThread).toHaveBeenCalledTimes(1)
})
