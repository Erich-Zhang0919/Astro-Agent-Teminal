import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AIMessage, ToolMessage } from '@langchain/core/messages'
import { MemorySaver } from '@langchain/langgraph'
import { agentTool } from './agent_tool'
import { permissionLevelOf } from '../permission/util'
import { createAgentGraph } from '../agent-graph'
import { runGraphWithApprovals } from '../agent-runner'

jest.mock('../tools', () => ({ maybePersistedOutput: async (text: string) => text }))

describe('agent_tool', () => {
    it('is an exec tool and passes only the prompt to the launcher', async () => {
        const runSubAgent = jest.fn(async () => 'child result')
        expect(agentTool.name).toBe('agent_tool')
        expect(permissionLevelOf(agentTool)).toBe('exec')
        await expect(agentTool.invoke({ prompt: '  independent task\n' }, {
            context: { runSubAgent }, configurable: { thread_id: 'parent' },
        })).resolves.toBe('child result')
        expect(runSubAgent.mock.calls).toEqual([['  independent task\n']])
    })

    it.each([
        {}, { prompt: '' }, { prompt: ' \n\t' }, { prompt: 123 }, { prompt: null },
        { prompt: ['task'] }, { prompt: 'task', messages: [] },
        { prompt: 'task', thread_id: 'parent' },
    ])('rejects invalid input without starting a child: %j', async input => {
        const runSubAgent = jest.fn()
        await expect(agentTool.invoke(input as { prompt: string }, { context: { runSubAgent } }))
            .rejects.toThrow()
        expect(runSubAgent).not.toHaveBeenCalled()
    })

    it('fails explicitly when delegation is unavailable', async () => {
        await expect(agentTool.invoke({ prompt: 'task' }))
            .rejects.toThrow('SubAgent delegation is not available')
    })

    it('propagates launcher failures to the tool executor', async () => {
        await expect(agentTool.invoke({ prompt: 'task' }, {
            context: { runSubAgent: async () => { throw new Error('child failed') } },
        })).rejects.toThrow('child failed')
    })

    it.each([true, false, undefined])('requires approval before launching: %s', async approved => {
        const runSubAgent = jest.fn(async () => 'child result')
        const invoke = jest.fn()
            .mockResolvedValueOnce(new AIMessage({ content: '', tool_calls: [
                { name: 'agent_tool', id: 'delegate', args: { prompt: 'task' }, type: 'tool_call' },
            ] }))
            .mockResolvedValue(new AIMessage('parent continued'))
        const graph = createAgentGraph({
            model: { bindTools: () => ({ invoke }) } as unknown as BaseChatModel,
            tools: [agentTool], systemPrompt: 'test', checkpointer: new MemorySaver(),
        })
        const confirmTool = jest.fn(async () => approved === true)
        await runGraphWithApprovals(graph, 'request', () => undefined,
            { configurable: { thread_id: 'approval' }, context: { runSubAgent } }, 'test',
            undefined, approved === undefined ? undefined : confirmTool)
        if (approved !== undefined) expect(confirmTool).toHaveBeenCalledWith(expect.objectContaining({
            name: 'agent_tool', args: { prompt: 'task' },
        }))
        expect(runSubAgent).toHaveBeenCalledTimes(approved ? 1 : 0)
        const results = invoke.mock.calls[1][0].filter(ToolMessage.isInstance)
        expect(results[0]).toMatchObject({
            tool_call_id: 'delegate', status: approved ? 'success' : 'error',
            ...(approved ? { content: 'child result' } : {}),
        })
    })
})
