import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import { tool } from '@langchain/core/tools'
import { Command, MemorySaver } from '@langchain/langgraph'
import { z } from 'zod'
import { createAgentGraph, CreateAgentGraphOptions } from './agent-graph'
import { maybePersistedOutput } from './tools'

jest.mock('./tools/web_search', () => ({ webSearchTool: {} }))

let tmpDir: string
let originalCwd: string

beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-output-test-'))
    originalCwd = process.cwd()
    process.chdir(tmpDir)
})

afterEach(async () => {
    process.chdir(originalCwd)
    jest.restoreAllMocks()
    await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('maybePersistedOutput', () => {
    it.each([0, 49_999, 50_000])('returns %i characters without creating a directory', async (length) => {
        const content = 'x'.repeat(length)
        expect(await maybePersistedOutput(content, 'short')).toBe(content)
        await expect(fs.stat('tool_output')).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('persists 50001 characters in full and returns the exact preview format', async () => {
        const content = 'x'.repeat(50_001)
        const result = await maybePersistedOutput(content, 'boundary')

        expect(await fs.readFile('tool_output/tool_output_boundary.txt', 'utf-8')).toBe(content)
        expect(result).toBe([
            '<persisted-output>',
            'Output too large (48.8KB).',
            'Full output saved to: ./tool_output/tool_output_boundary.txt',
            'If you need the complete content, it is recommended to read it in segments',
            '',
            'Preview (first 2KB):',
            'x'.repeat(2000),
            '...',
            '</persisted-output>',
        ].join('\n'))
    })

    it('uses character length for Chinese content and stores complete UTF-8 text', async () => {
        const shortContent = '中文'.repeat(25_000)
        expect(await maybePersistedOutput(shortContent, 'chinese')).toBe(shortContent)
        await expect(fs.stat('tool_output')).rejects.toMatchObject({ code: 'ENOENT' })

        const longContent = shortContent + '末'
        const result = await maybePersistedOutput(longContent, 'chinese')
        expect(await fs.readFile('tool_output/tool_output_chinese.txt', 'utf-8')).toBe(longContent)
        expect(result).toContain('Output too large (48.8KB).')
        expect(result).toContain(`Preview (first 2KB):\n${'中文'.repeat(1000)}\n...`)
    })

    it('encodes path characters in call IDs and overwrites the same call output', async () => {
        const callId = '../nested\\call/中文%'
        const content = 'a'.repeat(50_001)
        await maybePersistedOutput(content, callId)
        const updatedContent = 'b'.repeat(50_002)
        const result = await maybePersistedOutput(updatedContent, callId)
        const filename = `tool_output_${encodeURIComponent(callId)}.txt`

        expect(await fs.readdir('tool_output')).toEqual([filename])
        expect(await fs.readFile(path.join('tool_output', filename), 'utf-8')).toBe(updatedContent)
        expect(result).toContain(`Full output saved to: ./tool_output/${filename}`)
    })

    it('propagates write failures instead of claiming the file was saved', async () => {
        await fs.mkdir('tool_output/tool_output_failure.txt', { recursive: true })
        await expect(maybePersistedOutput('x'.repeat(50_001), 'failure')).rejects.toMatchObject({
            code: 'EISDIR',
        })
    })
})

function setupGraph(tools: CreateAgentGraphOptions['tools']) {
    const invoke = jest.fn()
        .mockResolvedValueOnce(new AIMessage({
            content: '',
            tool_calls: tools.map((entry) => ({
                name: entry.name,
                id: `call_${entry.name}`,
                args: {},
                type: 'tool_call' as const,
            })),
        }))
        .mockResolvedValue(new AIMessage('done'))
    const model = { bindTools: () => ({ invoke }) } as unknown as BaseChatModel
    const graph = createAgentGraph({
        model,
        tools,
        systemPrompt: 'test',
        checkpointer: new MemorySaver(),
    })
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    return { graph, invoke, logSpy }
}

describe('toolNode output persistence', () => {
    it('persists multiple outputs before the next model call and preserves message metadata', async () => {
        const firstContent = 'a'.repeat(50_001)
        const secondContent = '中文'.repeat(30_000)
        const detailedMessage = new ToolMessage({
            content: firstContent,
            tool_call_id: 'call_first',
            id: 'message-first',
            name: 'first',
            status: 'error',
            artifact: { source: 'test' },
            metadata: { custom: 1 },
            additional_kwargs: { detail: true },
            response_metadata: { elapsed: 2 },
        })
        const blocks = [{ type: 'text' as const, text: 'structured'.repeat(10_000) }]
        const { graph, invoke, logSpy } = setupGraph([
            tool(() => detailedMessage, { name: 'first', schema: z.object({}) }),
            tool(() => secondContent, { name: 'second', schema: z.object({}) }),
            tool(() => 'short', { name: 'short', schema: z.object({}) }),
            tool(() => new ToolMessage({ content: blocks, tool_call_id: 'call_blocks' }), {
                name: 'blocks', schema: z.object({}),
            }),
        ])
        const config = { configurable: { thread_id: 'multiple' } }
        const result = await graph.invoke({ messages: [new HumanMessage('run tools')] }, config)
        const messages = result.messages.filter((message) => ToolMessage.isInstance(message))

        expect(messages.map((message) => message.tool_call_id)).toEqual([
            'call_first', 'call_second', 'call_short', 'call_blocks',
        ])
        expect(messages[0]).toMatchObject({
            id: 'message-first', name: 'first', status: 'error',
            artifact: { source: 'test' }, metadata: { custom: 1 },
            additional_kwargs: { detail: true }, response_metadata: { elapsed: 2 },
        })
        expect(messages[0].content).toContain('<persisted-output>')
        expect(messages[1].content).toContain('<persisted-output>')
        expect(messages[2].content).toBe('short')
        expect(messages[3].content).toEqual(blocks)
        expect(await fs.readFile('tool_output/tool_output_call_first.txt', 'utf-8')).toBe(firstContent)
        expect(await fs.readFile('tool_output/tool_output_call_second.txt', 'utf-8')).toBe(secondContent)
        expect((await fs.readdir('tool_output')).sort()).toEqual([
            'tool_output_call_first.txt', 'tool_output_call_second.txt',
        ])
        const nextModelMessages = invoke.mock.calls[1][0] as BaseMessage[]
        expect(nextModelMessages.filter((message) => ToolMessage.isInstance(message))).toEqual(messages)
        const saved = await graph.getState(config)
        const savedMessages = (saved.values.messages as BaseMessage[])
            .filter((message) => ToolMessage.isInstance(message))
        const messageFields = (message: ToolMessage) => ({
            id: message.id, content: message.content, tool_call_id: message.tool_call_id,
            name: message.name, status: message.status, artifact: message.artifact,
            metadata: message.metadata, additional_kwargs: message.additional_kwargs,
            response_metadata: message.response_metadata,
        })
        expect(savedMessages.map(messageFields)).toEqual(messages.map(messageFields))
        expect(logSpy.mock.calls).toEqual([['first'], ['second'], ['short'], ['blocks']])
    })

    it('keeps Command results intact while processing accompanying message updates', async () => {
        const commandMessage = new ToolMessage({ content: 'command result', tool_call_id: 'call_command' })
        const command = new Command({ update: { messages: [commandMessage] } })
        const { graph } = setupGraph([
            tool(() => command, { name: 'command', schema: z.object({}) }),
            tool(() => 'x'.repeat(50_001), { name: 'long', schema: z.object({}) }),
        ])

        const result = await graph.invoke({ messages: [new HumanMessage('run tools')] }, {
            configurable: { thread_id: 'command' },
        })
        const messages = result.messages.filter((message) => ToolMessage.isInstance(message))
        expect(messages[0].content).toBe('command result')
        expect(messages[1].content).toContain('<persisted-output>')
        expect(command.update).toEqual({ messages: [commandMessage] })
    })

    it('propagates persistence failures without making another model call', async () => {
        await fs.mkdir('tool_output/tool_output_call_failure.txt', { recursive: true })
        const { graph, invoke } = setupGraph([
            tool(() => 'x'.repeat(50_001), { name: 'failure', schema: z.object({}) }),
        ])

        await expect(graph.invoke({ messages: [new HumanMessage('run tools')] }, {
            configurable: { thread_id: 'failure' },
        })).rejects.toMatchObject({ code: 'EISDIR' })
        expect(invoke).toHaveBeenCalledTimes(1)
    })
})
