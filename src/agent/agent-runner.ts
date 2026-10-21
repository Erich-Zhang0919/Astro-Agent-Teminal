import { Command, GraphRecursionError } from '@langchain/langgraph'
import { isAIMessage, ToolMessage } from '@langchain/core/messages'
import { randomUUID } from 'node:crypto'
import type { AgentGraphContext, createAgentGraph, ToolApprovalRequest } from './agent-graph'
import { collectAgentStream, TokenUsage } from './context-usage'
import { mcpBindingMatches } from './mcp/types'
import { AGENT_RECURSION_LIMIT } from './agent-limits'

type AgentGraph = ReturnType<typeof createAgentGraph>

export interface AgentRunnerConfig {
    configurable: { thread_id: string }
    context?: AgentGraphContext
    recursionLimit?: number
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

    const decision = async (request: ToolApprovalRequest): Promise<boolean> => {
        if (request.mcp && !mcpBindingMatches(request.mcp,
            config.context?.toolset?.find(item => item.name === request.name))) return false
        return (await confirmTool?.(request)) === true
    }

    const requestFinalAnswer = async () => {
        const snapshot = await graph.getState(config)
        if (snapshot.next.includes('post_tool_hooks')) {
            // Tools have already executed. Preserve their outputs and run post hooks once.
            await graph.updateState(config, { finishRequested: true }, 'tools')
        } else {
            const last = snapshot.values.messages.at(-1)
            const cancelled = last && isAIMessage(last) ? (last.tool_calls ?? []).map(call => new ToolMessage({
                tool_call_id: call.id ?? '', name: call.name, status: 'error',
                content: 'This pending tool call was not executed. The previous run has stopped; use the available results to answer.',
            })) : []
            // Close pending calls to keep the provider's AI/tool message sequence valid.
            await graph.updateState(config, {
                messages: cancelled, hookUpdates: [], finishRequested: true,
            }, 'post_tool_hooks')
        }
    }

    const runUntilSettled = async (initialInput: Parameters<AgentGraph['stream']>[0]) => {
        let input = initialInput
        let recovering = false
        while (!signal?.aborted) {
            try {
                const stream = await graph.stream(input, {
                    ...config,
                    recursionLimit: recovering ? AGENT_RECURSION_LIMIT : config.recursionLimit ?? AGENT_RECURSION_LIMIT,
                    streamMode: 'messages', signal,
                })
                const segment = await collectAgentStream(
                    stream as AsyncIterable<unknown>, token => {
                        result.text += token
                        onToken(token)
                    }, configuredModelId, signal,
                )
                if (segment.usage) result.usage = segment.usage
                if (segment.text || segment.usage) result.modelId = segment.modelId
            } catch (error) {
                if (!(error instanceof GraphRecursionError) || recovering || signal?.aborted) throw error
                if (!(await graph.getState(config)).next.length) return
                await requestFinalAnswer()
                input = null
                recovering = true
                continue
            }

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
    // A new question supersedes a previous call that has not even reached review.
    // This also handles checkpoints left by the former 25-step recursion limit.
    if (!signal?.aborted && previousState.next?.includes('prepare_tools')) {
        await requestFinalAnswer()
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
