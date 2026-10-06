import type { ToolApprovalRequest } from './agent-graph'

export interface ToolApprovalPrompt {
    interactive: boolean
    readAnswer: (question: string) => Promise<string | undefined>
    write: (text: string) => void
}

export async function requestToolApproval(
    request: ToolApprovalRequest,
    prompt: ToolApprovalPrompt,
): Promise<boolean> {
    prompt.write(`\nTool ${request.index}/${request.total}: ${request.name}\n`)
    prompt.write(`Arguments:\n${JSON.stringify(request.args, null, 2)}\n`)

    if (!prompt.interactive) {
        prompt.write('[Denied: no interactive terminal]\n')
        return false
    }

    try {
        const answer = await prompt.readAnswer('Approve this tool call? [y/N] ')
        const approved = /^(y|yes)$/i.test(answer?.trim() ?? '')
        prompt.write(approved ? '[Approved]\n' : '[Denied]\n')
        return approved
    } catch {
        prompt.write('[Denied: confirmation failed]\n')
        return false
    }
}
