import { Command } from '@langchain/langgraph'
import { isAIMessage } from '@langchain/core/messages'
import { randomUUID } from 'node:crypto'
import type { AgentGraphContext, createAgentGraph, ToolApprovalRequest } from './agent-graph'
import { collectAgentStream, TokenUsage } from './context-usage'

type AgentGraph = ReturnType<typeof createAgentGraph>

export interface AgentRunnerConfig {
    configurable: { thread_id: string }
    context?: AgentGraphContext
}

export interface AgentRunnerResult {
    text: string
    modelId: string
    usage?: TokenUsage
}

export async function runGraphWithApprovals(
    graph: AgentGraph,
    userMessage: string,
    onToken: (token: string) => void,
    config: AgentRunnerConfig,
    configuredModelId: string,
    signal?: AbortSignal,
    confirmTool?: (request: ToolApprovalRequest) => Promise<boolean>,
): Promise<AgentRunnerResult> {
    const result: AgentRunnerResult = { text: '', modelId: configuredModelId }

    const approvalFromSnapshot = (snapshot: Awaited<ReturnType<AgentGraph['getState']>>):
        ToolApprovalRequest | undefined => {
        const pending = snapshot.tasks.flatMap((task) => task.interrupts)[0]
        if (!pending) return undefined
        const value = pending.value
        if (!value || typeof value !== 'object' ||
            typeof value.name !== 'string' ||
            typeof value.index !== 'number' ||
            typeof value.total !== 'number' ||
            !value.args || typeof value.args !== 'object') {
            throw new Error('The agent has an unrecognized pending interrupt.')
        }
        return value as ToolApprovalRequest
    }
    const pendingApproval = async () => approvalFromSnapshot(await graph.getState(config))

    const decision = async (request: ToolApprovalRequest): Promise<boolean> =>
        (await confirmTool?.(request)) === true

    const runUntilSettled = async (initialInput: Parameters<AgentGraph['stream']>[0]) => {
        let input = initialInput
        while (!signal?.aborted) {
            const stream = await graph.stream(input, {
                ...config, streamMode: 'messages', signal,
            })
            const segment = await collectAgentStream(
                stream as AsyncIterable<unknown>, onToken, configuredModelId, signal,
            )
            result.text += segment.text
            if (segment.usage) result.usage = segment.usage
            if (segment.text || segment.usage) result.modelId = segment.modelId

            if (signal?.aborted) return
            const pending = await pendingApproval()
            if (!pending) return
            const approved = await decision(pending)
            if (signal?.aborted) return
            input = new Command({ resume: { approved } })
        }
    }

    // A previous run may have been cancelled while waiting for confirmation.
    // Resolve its checkpoint before adding a new user message to this thread.
    let previousState = await graph.getState(config)
    if (!signal?.aborted && previousState.next?.includes('tools') && !previousState.values.hookBatchId) {
        // Before hooks existed, approval checkpoints pointed straight at tools.
        // Rebase that boundary to the new pre-hook stage without asking again.
        const message = previousState.values.messages.at(-1)
        if (!message || !isAIMessage(message)) throw new Error('Invalid legacy tool checkpoint.')
        await graph.updateState(config, {
            hookBatchId: randomUUID(), hookCalls: message.tool_calls ?? [],
            hookUpdates: [], pendingHookMessages: [],
        }, 'review_tools')
        previousState = await graph.getState(config)
    }
    const previousApproval = approvalFromSnapshot(previousState)
    if (previousApproval && !signal?.aborted) {
        const approved = await decision(previousApproval)
        if (!signal?.aborted) {
            await runUntilSettled(new Command({ resume: { approved } }))
        }
    } else if (previousState.next?.length && !signal?.aborted) {
        // Resume checkpointed work before adding a new message, including a tool
        // result whose post hooks were cancelled in a previous run.
        await runUntilSettled(null)
    }
    if (!signal?.aborted) {
        await runUntilSettled({ messages: [{ role: 'user', content: userMessage }] })
    }

    return result
}
