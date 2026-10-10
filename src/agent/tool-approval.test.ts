import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import { tool } from '@langchain/core/tools'
import { Command, MemorySaver } from '@langchain/langgraph'
import { z } from 'zod'
import { createAgentGraph, ToolApprovalRequest } from './agent-graph'
import { runGraphWithApprovals } from './agent-runner'
import { requestToolApproval } from './tool-approval'
import { decideReadPermission } from './permission/read'
import { isInProjectDir, withPermissionLevel } from './permission/util'
import { decideWritePermission } from './permission/write'
import { readFileFn } from './tools/read_file'
import { writeFileFn } from './tools/write_file'

jest.mock('./tools', () => ({ maybePersistedOutput: async (content: string) => content }))

function setupGraph() {
    const first = jest.fn(async ({ value }: { value: string }) => `first:${value}`)
    const second = jest.fn(async ({ value }: { value: string }) => `second:${value}`)
    const calls = [
        { name: 'first', id: 'call_1', args: { value: 'one', command: 'true' }, type: 'tool_call' as const },
        { name: 'second', id: 'call_2', args: { value: 'two', command: 'true' }, type: 'tool_call' as const },
    ]
    const invoke = jest.fn()
        .mockResolvedValueOnce(new AIMessage({ content: '', tool_calls: calls }))
        .mockResolvedValue(new AIMessage('done'))
    const model = { bindTools: () => ({ invoke }) } as unknown as BaseChatModel
    const checkpointer = new MemorySaver()
    const tools = [
        withPermissionLevel(tool(first, { name: 'first',
            schema: z.object({ value: z.string(), command: z.literal('true') }) }), 'exec'),
        withPermissionLevel(tool(second, { name: 'second',
            schema: z.object({ value: z.string(), command: z.literal('true') }) }), 'exec'),
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
    it.each([{}, { permission_level: 'custom' }, { permission_tool: 'custom' }])(
        'runs tools without a matching permission check without confirmation: %j', async (metadata) => {
            const execute = jest.fn(async () => 'ran')
            const invoke = jest.fn()
                .mockResolvedValueOnce(new AIMessage({ content: '', tool_calls: [
                    { name: 'unchecked', id: 'unchecked_call', args: {}, type: 'tool_call' },
                ] }))
                .mockResolvedValue(new AIMessage('done'))
            const graph = createAgentGraph({
                model: { bindTools: () => ({ invoke }) } as unknown as BaseChatModel,
                tools: [Object.assign(tool(execute, { name: 'unchecked', schema: z.object({}) }), metadata)],
                systemPrompt: 'test', checkpointer: new MemorySaver(),
            })
            const confirmTool = jest.fn(async () => false)
            const config = { configurable: { thread_id: 'unchecked-tool' } }

            await runGraphWithApprovals(graph, 'run tool', () => undefined,
                config, 'test-model', undefined, confirmTool)

            expect(confirmTool).not.toHaveBeenCalled()
            expect(execute).toHaveBeenCalledTimes(1)
            expect(await pendingRequest(graph, config)).toBeUndefined()
            const messages = (invoke.mock.calls[1][0] as BaseMessage[]).filter(ToolMessage.isInstance)
            expect(messages[0].content).toBe('ran')
        },
    )

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
                tool_calls: [{ name: 'idless', args: { command: 'true' }, type: 'tool_call' }],
            }))
            .mockResolvedValue(new AIMessage('done'))
        const model = { bindTools: () => ({ invoke }) } as unknown as BaseChatModel
        const graph = createAgentGraph({
            model,
            tools: [withPermissionLevel(tool(execute, {
                name: 'idless', schema: z.object({ command: z.literal('true') }),
            }), 'exec')],
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
        const toolCall = { name: 'repeat', id: 'reused', args: { command: 'true' }, type: 'tool_call' as const }
        const invoke = jest.fn()
            .mockResolvedValueOnce(new AIMessage({ content: '', tool_calls: [toolCall] }))
            .mockResolvedValueOnce(new AIMessage('first done'))
            .mockResolvedValueOnce(new AIMessage({ content: '', tool_calls: [toolCall] }))
            .mockResolvedValue(new AIMessage('second done'))
        const model = { bindTools: () => ({ invoke }) } as unknown as BaseChatModel
        const graph = createAgentGraph({
            model,
            tools: [withPermissionLevel(tool(execute, {
                name: 'repeat', schema: z.object({ command: z.literal('true') }),
            }), 'exec')],
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

    it('automatically runs a read tool when file_path is absent', async () => {
        const execute = jest.fn(async () => 'ran')
        const invoke = jest.fn()
            .mockResolvedValueOnce(new AIMessage({ content: '', tool_calls: [
                { name: 'optional_path', id: 'call_no_path', args: {}, type: 'tool_call' },
            ] }))
            .mockResolvedValue(new AIMessage('done'))
        const model = { bindTools: () => ({ invoke }) } as unknown as BaseChatModel
        const graph = createAgentGraph({
            model,
            tools: [withPermissionLevel(tool(execute, {
                name: 'optional_path', schema: z.object({}),
            }), 'read')],
            systemPrompt: 'test', checkpointer: new MemorySaver(),
        })
        const confirmTool = jest.fn(async () => true)

        await runGraphWithApprovals(graph, 'run tool', () => undefined,
            { configurable: { thread_id: 'no-path' } }, 'test-model', undefined, confirmTool)

        expect(confirmTool).not.toHaveBeenCalled()
        expect(execute).toHaveBeenCalledTimes(1)
    })

    it.each([true, false])('blocks external exec calls and confirms local calls (approval: %s)', async (approved) => {
        const execute = jest.fn(async ({ command }: { command: string }) => command)
        const invoke = jest.fn()
            .mockResolvedValueOnce(new AIMessage({ content: '', tool_calls: [
                { name: 'shell_tool', id: 'outside_exec', type: 'tool_call',
                    args: { command: 'cd .. && pwd' } },
                { name: 'shell_tool', id: 'local_exec', type: 'tool_call',
                    args: { command: 'true' } },
            ] }))
            .mockResolvedValue(new AIMessage('done'))
        const model = { bindTools: () => ({ invoke }) } as unknown as BaseChatModel
        const graph = createAgentGraph({
            model,
            tools: [Object.assign(tool(execute, {
                name: 'shell_tool', schema: z.object({ command: z.string() }),
            }), { permission_tool: 'exec' })],
            systemPrompt: 'test', checkpointer: new MemorySaver(),
        })
        const confirmTool = jest.fn(async () => approved)

        await runGraphWithApprovals(graph, 'run commands', () => undefined,
            { configurable: { thread_id: `exec-permission-${approved}` } },
            'test-model', undefined, confirmTool)

        expect(confirmTool).toHaveBeenCalledTimes(1)
        expect(confirmTool).toHaveBeenCalledWith(expect.objectContaining({
            toolCallId: 'local_exec', args: { command: 'true' },
        }))
        expect(execute).toHaveBeenCalledTimes(approved ? 1 : 0)
        if (approved) expect(execute.mock.calls[0][0]).toEqual({ command: 'true' })
        const messages = (invoke.mock.calls[1][0] as BaseMessage[]).filter(ToolMessage.isInstance)
        expect(messages[0]).toMatchObject({ tool_call_id: 'outside_exec', status: 'error' })
        expect(messages[0].content).toContain('Blocked: command')
        expect(messages[1].content).toBe(approved ? 'true' :
            'The user rejected this tool call. Do not retry it without a new user request.')
    })

    it('executes allowlisted commands without approval while blocking unsafe calls and confirming other calls', async () => {
        const execute = jest.fn(async ({ command }: { command: string }) => command)
        const commands = ['pwd', 'cat .env', 'true', 'ls', 'git status', 'echo hello']
        const invoke = jest.fn()
            .mockResolvedValueOnce(new AIMessage({ content: '', tool_calls: commands.map((command, index) => ({
                name: 'exec', id: `allowlist_${index}`, type: 'tool_call' as const, args: { command },
            })) }))
            .mockResolvedValue(new AIMessage('done'))
        const graph = createAgentGraph({
            model: { bindTools: () => ({ invoke }) } as unknown as BaseChatModel,
            tools: [withPermissionLevel(tool(execute, {
                name: 'exec', schema: z.object({ command: z.string() }),
            }), 'exec')],
            systemPrompt: 'test', checkpointer: new MemorySaver(),
        })
        const confirmTool = jest.fn(async () => false)
        await runGraphWithApprovals(graph, 'run commands', () => undefined,
            { configurable: { thread_id: 'safe-commands-auto-approved' } },
            'test-model', undefined, confirmTool)

        expect(confirmTool).toHaveBeenCalledTimes(1)
        expect(confirmTool).toHaveBeenCalledWith(expect.objectContaining({ args: { command: 'true' } }))
        expect(execute.mock.calls.map(([args]) => args.command)).toEqual(['pwd', 'ls', 'git status', 'echo hello'])
        const messages = (invoke.mock.calls[1][0] as BaseMessage[]).filter(ToolMessage.isInstance)
        expect(messages[1].content).toContain('sensitive information access')
        expect(messages[2].content).toContain('user rejected')
    })

    it.each([true, false, undefined])('automatically runs safe/no-URL network calls and gates other domains (approval: %s)', async (approved) => {
        const execute = jest.fn(async ({ url, query }: { url?: string; query?: string }) => url ?? query ?? 'no URL')
        const calls = [
            { name: 'network_tool', id: 'safe_url', args: { url: 'https://docs.python.org/path' }, type: 'tool_call' as const },
            { name: 'network_tool', id: 'no_url', args: { query: 'search terms' }, type: 'tool_call' as const },
            { name: 'network_tool', id: 'unknown_url', args: { url: 'https://untrusted.invalid/path' }, type: 'tool_call' as const },
        ]
        const invoke = jest.fn()
            .mockResolvedValueOnce(new AIMessage({ content: '', tool_calls: calls }))
            .mockResolvedValue(new AIMessage('done'))
        const graph = createAgentGraph({
            model: { bindTools: () => ({ invoke }) } as unknown as BaseChatModel,
            tools: [Object.assign(tool(execute, {
                name: 'network_tool', schema: z.object({ url: z.string().optional(), query: z.string().optional() }),
            }), { permission_level: 'network', permission_tool: 'read' })],
            systemPrompt: 'test', checkpointer: new MemorySaver(),
        })
        const confirmTool = jest.fn(async () => approved === true)
        await runGraphWithApprovals(graph, 'run network calls', () => undefined,
            { configurable: { thread_id: `network-approval-${approved}` } },
            'test-model', undefined, approved === undefined ? undefined : confirmTool)

        if (approved === undefined) expect(confirmTool).not.toHaveBeenCalled()
        else {
            expect(confirmTool).toHaveBeenCalledTimes(1)
            expect(confirmTool).toHaveBeenCalledWith(expect.objectContaining({
                toolCallId: 'unknown_url', args: { url: 'https://untrusted.invalid/path' },
            }))
        }
        expect(execute.mock.calls.map(([args]) => args)).toEqual(
            (approved === true ? calls : calls.slice(0, 2)).map((call) => call.args),
        )
        const messages = (invoke.mock.calls[1][0] as BaseMessage[]).filter(ToolMessage.isInstance)
        expect(messages[0].content).toBe('https://docs.python.org/path')
        expect(messages[1].content).toBe('search terms')
        expect(messages[2].content).toBe(approved === true ? 'https://untrusted.invalid/path'
            : 'The user rejected this tool call. Do not retry it without a new user request.')
    })

    it('blocks language execution without requesting approval and returns tool guidance to the model', async () => {
        const execute = jest.fn(async () => 'ran')
        const commands = ['python3 script.py', 'node script.js', 'go run main.go']
        const invoke = jest.fn()
            .mockResolvedValueOnce(new AIMessage({ content: '', tool_calls: commands.map((command, index) => ({
                name: 'exec', id: `language_${index}`, type: 'tool_call' as const, args: { command },
            })) }))
            .mockResolvedValue(new AIMessage('done'))
        const graph = createAgentGraph({
            model: { bindTools: () => ({ invoke }) } as unknown as BaseChatModel,
            tools: [withPermissionLevel(tool(execute, {
                name: 'exec', schema: z.object({ command: z.string() }),
            }), 'exec')],
            systemPrompt: 'test', checkpointer: new MemorySaver(),
        })
        const confirmTool = jest.fn(async () => true)

        await runGraphWithApprovals(graph, 'run scripts', () => undefined,
            { configurable: { thread_id: 'language-execution-blocked' } },
            'test-model', undefined, confirmTool)

        expect(confirmTool).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
        const messages = (invoke.mock.calls[1][0] as BaseMessage[]).filter(ToolMessage.isInstance)
        expect(messages).toHaveLength(3)
        expect(messages.every((message) => message.status === 'error')).toBe(true)
        expect(messages[0].content).toContain('run_py')
        expect(messages[1].content).toContain('run_js')
        expect(messages[2].content).toContain('non-shell')
    })

    it('blocks every dangerous operation category before approval or execution', async () => {
        const execute = jest.fn(async () => 'ran')
        const commands = ['sudo ls', 'rm file', 'mv a b', 'chmod 777 file',
            'kill 123', 'useradd user', 'cat .env', 'curl https://example.com']
        const invoke = jest.fn()
            .mockResolvedValueOnce(new AIMessage({ content: '', tool_calls: commands.map((command, index) => ({
                name: 'exec', id: `danger_${index}`, type: 'tool_call' as const, args: { command },
            })) }))
            .mockResolvedValue(new AIMessage('done'))
        const graph = createAgentGraph({
            model: { bindTools: () => ({ invoke }) } as unknown as BaseChatModel,
            tools: [withPermissionLevel(tool(execute, {
                name: 'exec', schema: z.object({ command: z.string() }),
            }), 'exec')],
            systemPrompt: 'test', checkpointer: new MemorySaver(),
        })
        const confirmTool = jest.fn(async () => true)

        await runGraphWithApprovals(graph, 'run commands', () => undefined,
            { configurable: { thread_id: 'dangerous-commands-blocked' } },
            'test-model', undefined, confirmTool)

        expect(confirmTool).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
        const messages = (invoke.mock.calls[1][0] as BaseMessage[]).filter(ToolMessage.isInstance)
        expect(messages).toHaveLength(commands.length)
        expect(messages.every((message) => message.status === 'error' &&
            String(message.content).includes('Blocked: dangerous operation'))).toBe(true)
    })

    it('runs safe reads, blocks dangerous paths, and confirms writes outside the project', async () => {
        const root = fs.mkdtempSync(path.join(process.cwd(), '.permission-graph-'))
        const project = path.join(root, 'project')
        const originalCwd = process.cwd()
        fs.mkdirSync(project)
        fs.writeFileSync(path.join(project, 'local.txt'), 'local content')
        fs.writeFileSync(path.join(root, 'outside-read.txt'), 'outside content')
        process.chdir(project)

        try {
            const other = jest.fn(async () => 'other result')
            const calls = [
                { name: 'read_file', id: 'local', args: { file_path: 'local.txt' }, type: 'tool_call' as const },
                { name: 'read_file', id: 'outside_read',
                    args: { file_path: '../outside-read.txt' }, type: 'tool_call' as const },
                { name: 'read_file', id: 'danger',
                    args: { file_path: path.join(os.homedir(), '.ssh', 'id_ed25519') }, type: 'tool_call' as const },
                { name: 'write_file', id: 'outside',
                    args: { file_path: '../outside.txt', content: 'outside' }, type: 'tool_call' as const },
                { name: 'other', id: 'other', args: {}, type: 'tool_call' as const },
            ]
            const invoke = jest.fn()
                .mockResolvedValueOnce(new AIMessage({ content: '', tool_calls: calls }))
                .mockResolvedValue(new AIMessage('done'))
            const model = { bindTools: () => ({ invoke }) } as unknown as BaseChatModel
            const graph = createAgentGraph({
                model,
                tools: [
                    withPermissionLevel(tool(readFileFn, { name: 'read_file',
                        schema: z.object({ file_path: z.string() }) }), 'read'),
                    withPermissionLevel(tool(writeFileFn, { name: 'write_file',
                        schema: z.object({ file_path: z.string(), content: z.string() }) }), 'write'),
                    tool(other, { name: 'other', schema: z.object({}) }),
                ],
                systemPrompt: 'test', checkpointer: new MemorySaver(),
            })
            const confirmTool = jest.fn(async () => false)

            await runGraphWithApprovals(graph, 'run tools', () => undefined,
                { configurable: { thread_id: 'path-decisions' } },
                'test-model', undefined, confirmTool)

            expect(confirmTool).toHaveBeenCalledTimes(1)
            expect(confirmTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'write_file' }))
            expect(other).toHaveBeenCalledTimes(1)
            expect(fs.existsSync(path.join(root, 'outside.txt'))).toBe(false)
            const messages = (invoke.mock.calls[1][0] as BaseMessage[])
                .filter(ToolMessage.isInstance)
            expect(messages.map((message) => message.tool_call_id))
                .toEqual(['local', 'outside_read', 'danger', 'outside', 'other'])
            expect(messages[0].content).toBe('local content')
            expect(messages[1].content).toBe('outside content')
            expect(messages[2].content).toContain('protected path')
            expect(messages[3].content).toContain('user rejected')
        } finally {
            process.chdir(originalCwd)
            fs.rmSync(root, { recursive: true, force: true })
        }
    })

    it('writes an external file after the user approves it', async () => {
        const root = fs.mkdtempSync(path.join(process.cwd(), '.permission-graph-'))
        const project = path.join(root, 'project')
        const originalCwd = process.cwd()
        fs.mkdirSync(project)
        process.chdir(project)

        try {
            const invoke = jest.fn()
                .mockResolvedValueOnce(new AIMessage({ content: '', tool_calls: [
                    { name: 'write_file', id: 'external', type: 'tool_call',
                        args: { file_path: '../outside.txt', content: 'approved content' } },
                ] }))
                .mockResolvedValue(new AIMessage('done'))
            const model = { bindTools: () => ({ invoke }) } as unknown as BaseChatModel
            const graph = createAgentGraph({
                model,
                tools: [withPermissionLevel(tool(writeFileFn, {
                    name: 'write_file',
                    schema: z.object({ file_path: z.string(), content: z.string() }),
                }), 'write')],
                systemPrompt: 'test', checkpointer: new MemorySaver(),
            })
            const confirmTool = jest.fn(async () => true)

            await runGraphWithApprovals(graph, 'write file', () => undefined,
                { configurable: { thread_id: 'external-approved' } },
                'test-model', undefined, confirmTool)

            expect(confirmTool).toHaveBeenCalledTimes(1)
            expect(fs.readFileSync(path.join(root, 'outside.txt'), 'utf-8'))
                .toBe('approved content')
        } finally {
            process.chdir(originalCwd)
            fs.rmSync(root, { recursive: true, force: true })
        }
    })
})

describe('file path permission decisions', () => {
    it('allows safe reads and confirms writes outside the project', () => {
        const cwd = process.cwd()
        expect(decideReadPermission({ file_path: 'src/agent/agent.ts' }, cwd))
            .toEqual({ kind: 'allow' })
        expect(decideReadPermission({ file_path: '../outside.txt' }, cwd))
            .toEqual({ kind: 'allow' })
        expect(decideWritePermission({ file_path: path.join(cwd, 'new.txt') }, cwd))
            .toEqual({ kind: 'allow' })
        expect(decideWritePermission({ file_path: '../outside.txt' }, cwd))
            .toEqual({ kind: 'confirm' })
        expect(decideReadPermission({}, cwd)).toEqual({ kind: 'allow' })
        expect(decideWritePermission({}, cwd)).toEqual({ kind: 'allow' })
    })

    it('checks symlinks and blocks dangerous targets before project membership', () => {
        const root = fs.mkdtempSync(path.join(process.cwd(), '.permission-path-'))
        const project = path.join(root, 'project')
        const outside = path.join(root, 'outside')
        fs.mkdirSync(project)
        fs.mkdirSync(outside)
        fs.symlinkSync(outside, path.join(project, 'safe-link'), 'junction')
        fs.symlinkSync(os.homedir(), path.join(project, 'home-link'), 'junction')

        try {
            expect(isInProjectDir('safe-link/new.txt', project)).toBe(false)
            expect(decideReadPermission({ file_path: 'safe-link/new.txt' }, project))
                .toEqual({ kind: 'allow' })
            expect(decideWritePermission({ file_path: 'safe-link/new.txt' }, project))
                .toEqual({ kind: 'confirm' })
            expect(decideReadPermission({ file_path: 'home-link/.ssh/id_ed25519' }, project))
                .toMatchObject({ kind: 'block' })
            expect(decideWritePermission({ file_path: 'home-link/.ssh/id_ed25519' }, project))
                .toMatchObject({ kind: 'block' })
        } finally {
            fs.rmSync(root, { recursive: true, force: true })
        }
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
