import { Command } from '@langchain/langgraph'
import type { createAgentGraph, HistoryPreprocessor, ToolApprovalRequest } from './agent-graph'
import { collectAgentStream, TokenUsage } from './context-usage'

type AgentGraph = ReturnType<typeof createAgentGraph>

export interface AgentRunnerConfig {
    configurable: { thread_id: string }
    context?: { preprocessMessages: HistoryPreprocessor | undefined }
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

    const pendingApproval = async (): Promise<ToolApprovalRequest | undefined> => {
        const snapshot = await graph.getState(config)
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
    const previousApproval = await pendingApproval()
    if (previousApproval && !signal?.aborted) {
        const approved = await decision(previousApproval)
        if (!signal?.aborted) {
            await runUntilSettled(new Command({ resume: { approved } }))
        }
    }
    if (!signal?.aborted) {
        await runUntilSettled({ messages: [{ role: 'user', content: userMessage }] })
    }

    return result
}
