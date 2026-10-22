import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import type { BaseChatModelCallOptions } from '@langchain/core/language_models/chat_models'
import type { AgentGraphContext } from './agent-graph'
import type { HookInput } from './hooks'

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
jest.mock('./model', () => {
    const actual = jest.requireActual('./model')
    return { ...actual, createModels: () => actual.createModels({
        model: 'test-model', apiKey: 'test-key', baseURL: 'https://example.com/v1',
    }) }
})
jest.mock('./tools/web_search', () => {
    const { tool } = require('@langchain/core/tools')
    const { z } = require('zod')
    return { webSearchTool: tool(async () => 'unused test search', {
        name: 'tavily_search', schema: z.object({ query: z.string() }),
    }) }
})

import { MemorySaver } from '@langchain/langgraph'
import { agent, contextCompactionStore, endAgentSession, getMcpSessionStatus, runAgentStream, startAgentSession } from './agent'
import { checkpointer, db } from './db'
import { HookEngine } from './hooks'
import { MemoryHookContextStore } from './hooks'
import { delegationPrompt, systemPrompt } from './prompt'
import { tools } from './tools'
import * as toolRegistry from './tools'
import * as skillRegistry from './skills'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'

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

const playwrightSmoke = process.env.ASTRO_PLAYWRIGHT_EXECUTABLE ? it : it.skip
playwrightSmoke('real Playwright MCP shares a browser across parent and child', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'astro-playwright-smoke-'))
    const server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><head><title>Astro MCP acceptance</title></head><body><h1>Shared browser session</h1></body></html>')
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const port = (server.address() as { port: number }).port
    const path = join(temp, 'mcp.json')
    await writeFile(path, JSON.stringify({ mcpServers: { playwright: {
        command: 'npx', cwd: temp, args: ['-y', '@playwright/mcp@0.0.83', '--headless', '--isolated',
            '--executable-path', process.env.ASTRO_PLAYWRIGHT_EXECUTABLE, '--output-dir', temp],
        env: { npm_config_registry: 'https://registry.npmjs.org', npm_config_cache: '/private/tmp/astro-mcp-npm-cache' },
        connectTimeoutMs: 120_000, callTimeoutMs: 30_000,
    } } }))
    const navigate = 'mcp__playwright__browser_navigate'
    const snapshot = 'mcp__playwright__browser_snapshot'
    const screenshot = 'mcp__playwright__browser_take_screenshot'
    const confirmations: string[] = []
    mockRespond.mockImplementation(async (messages, options) => {
        const output = results(messages)
        for (const result of output) expect(result).not.toMatchObject({ status: 'error' })
        if (child(options)) {
            if (!output.length) return call(snapshot, {})
            expect(String(output[0].content)).toContain('Astro MCP acceptance')
            if (output.length === 1) return call(screenshot, { type: 'png', scale: 'css', filename: 'astro-acceptance.png' })
            expect(String(output[1].content)).toMatch(/Attachment|astro-acceptance\.png/)
            return new AIMessage('Child inspected the shared page and saved a screenshot.')
        }
        if (!output.length) return call(navigate, { url: `http://127.0.0.1:${port}` })
        if (output.length === 1) return delegate('Inspect the open page and save its screenshot.')
        return new AIMessage('Browser acceptance complete.')
    })
    const id = parentId()
    try {
        const diagnostics: string[] = []
        await startAgentSession(id, { mcpConfigPath: path, onMcpDiagnostic: message => diagnostics.push(message) })
        expect((await getMcpSessionStatus(id))[0].status).toBe('connected')
        const result = await runAgentStream('Browser acceptance', () => undefined, id, undefined, {
            confirmTool: async request => { confirmations.push(request.name); return true },
        })
        expect(result.text).toContain('Browser acceptance complete')
        expect(confirmations).toEqual([navigate, 'agent_tool', snapshot, screenshot])
        const image = await readFile(join(temp, 'astro-acceptance.png'))
        expect(image.subarray(1, 4).toString()).toBe('PNG')
    } finally {
        await endAgentSession(id, 'exit')
        server.closeAllConnections()
        await new Promise<void>(resolve => server.close(() => resolve()))
        await rm(temp, { recursive: true, force: true })
    }
}, 150_000)

it('shares an MCP connection with the child, keeps it alive, and isolates another parent', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'astro-mcp-child-'))
    const path = join(temp, 'mcp.json')
    const fixture = resolve(__dirname, 'mcp/fixtures/server.cjs')
    const pidFile = join(temp, 'pid')
    await writeFile(path, JSON.stringify({ mcpServers: { fixture: {
        command: process.execPath, args: [fixture], env: { MCP_FIXTURE_PID_FILE: pidFile },
        autoApprove: ['counter'], connectTimeoutMs: 5000,
    } } }))
    const counterName = 'mcp__fixture__counter'
    const childIds = new Set<string>()
    mockRespond.mockImplementation(async (messages, options) => {
        expect(options.testTools.some(item => item.name === counterName)).toBe(true)
        const output = results(messages)
        if (child(options)) {
            childIds.add(options.configurable.thread_id)
            expect(options.testTools.some(item => item.name === 'agent_tool')).toBe(false)
            return output.length ? new AIMessage(`Child counter ${output.at(-1)!.content}`) : call(counterName, {})
        }
        if (!output.length) return delegate('Increment the shared MCP counter')
        if (output.at(-1)!.name === 'agent_tool') return call(counterName, {})
        return new AIMessage(`Parent counter ${output.at(-1)!.content}`)
    })
    try {
        const parent = parentId()
        const confirm = jest.fn(async () => true)
        const result = await runAgentStream('Delegate counter', () => undefined, parent, undefined,
            { mcpConfigPath: path, confirmTool: confirm })
        expect(result.text).toContain('Parent counter 2')
        expect(confirm).toHaveBeenCalledTimes(1) // Delegation only; MCP is whitelisted.
        expect(childIds.size).toBe(1)
        const pid = Number(await readFile(pidFile, 'utf8'))
        expect(() => process.kill(pid, 0)).not.toThrow()
        expect((await getMcpSessionStatus(parent))[0].status).toBe('connected')
        const mcpHooks = hookRun.mock.calls.map(([input]) => input as HookInput)
            .filter(input => 'tool' in input && input.tool.name === counterName)
        expect(mcpHooks.map(input => input.event)).toEqual(['PreToolUse', 'PostToolUse', 'PreToolUse', 'PostToolUse'])

        mockRespond.mockImplementation(async (messages) => results(messages).length
            ? new AIMessage(`Independent counter ${results(messages).at(-1)!.content}`) : call(counterName, {}))
        const independent = await runAgentStream('Counter', () => undefined, parentId(), undefined, { mcpConfigPath: path })
        expect(independent.text).toContain('Independent counter 1')
        await endAgentSession(parent, 'exit')
        expect(() => process.kill(pid, 0)).toThrow()
    } finally {
        for (const id of parents) await endAgentSession(id, 'exit')
        await rm(temp, { recursive: true, force: true })
    }
})

it('isolates child input/tools/configuration and returns only the final answer before the parent continues', async () => {
    const loadSkill = jest.spyOn(skillRegistry, 'loadSkill').mockImplementation(name =>
        name === 'planner' ? '---\nname: planner\ndescription: Test planning skill\n---\nPlan the task.' : null)
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
            hooksPath: 'scripts/hooks.example.json' })
    expect(result.text).toBe('Delegating. PARENT FINAL')
    expect(tokens.join('')).toBe(result.text)
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    expect(approve).toHaveBeenCalledTimes(1)
    expect(preprocessMessages).toHaveBeenCalledTimes(2)
    expect(contextCompactionStore.get).toHaveBeenCalledTimes(1)
    expect(contextCompactionStore.get).toHaveBeenCalledWith(id)
    expect(loadHooks).toHaveBeenCalledWith(expect.objectContaining({
        hooksPath: 'scripts/hooks.example.json', onHookEvent, onDiagnostic: onHookDiagnostic,
    }))
    const childEvents = hookRun.mock.calls.map(([input]) => input as HookInput)
        .filter(input => input.sessionId === childId)
    expect(childEvents.map(input => input.event)).toEqual([
        'SessionStart', 'PreToolUse', 'PostToolUse', 'PreToolUse', 'PostToolUse', 'SessionEnd',
    ])
    expect(childEvents.at(-1)).toMatchObject({ reason: 'ask_completed' })
    expect(onToolEvent.mock.calls.map(([event]) => [event.type, event.name])).toContainEqual(['start', 'load_skill'])
    expect(loadSkill).toHaveBeenCalledWith('planner')
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
    await startAgentSession(id, { hooksPath: 'scripts/hooks.example.json', onHookEvent })
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
