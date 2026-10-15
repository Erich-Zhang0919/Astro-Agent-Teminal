import { tool, type ToolRuntime } from '@langchain/core/tools'
import { z } from 'zod'
import { withPermissionLevel } from '../permission/util'
import type { AgentGraphContext } from '../agent-graph'

export const agentTool = withPermissionLevel(tool(async ({ prompt }, runtime: ToolRuntime<unknown, AgentGraphContext>) => {
    const launch = runtime.context?.runSubAgent
    if (typeof launch !== 'function') {
        throw new Error('SubAgent delegation is not available in this agent.')
    }
    return launch(prompt)
}, {
    name: 'agent_tool',
    description: 'Delegate one independent task to a SubAgent and wait for its final result. ' +
        'Prefer doing simple or tightly coupled work yourself. Delegate when the task has a clear boundary, ' +
        'can be described by a self-contained prompt, and benefits from a separate working context, ' +
        'or when the user explicitly requests delegation. Follow mandatory skill routing first. ' +
        'Include the goal, necessary background, constraints and expected deliverable in the prompt. ' +
        'Chat history is not forwarded. SubAgents cannot delegate. Calls in the same session run sequentially. ' +
        'Review the returned result before integrating it into your response.',
    schema: z.object({
        prompt: z.string().refine(value => value.trim().length > 0, 'Prompt must not be blank.')
            .describe('A self-contained task with its goal, necessary background, constraints and deliverable.'),
    }).strict(),
}), 'exec')
