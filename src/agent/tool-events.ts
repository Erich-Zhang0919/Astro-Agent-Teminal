import type { ToolBlockReason } from './permission/util'

interface ToolExecutionInfo {
    toolCallId?: string
    name: string
    args: Record<string, unknown>
}

export type ToolExecutionEvent = ToolExecutionInfo & (
    | { type: 'start' }
    | { type: 'result'; status: 'success' | 'error'; content: unknown }
    | { type: 'result'; status: 'blocked'; content: unknown; reason: ToolBlockReason }
)

export type ToolEventCallback = (event: ToolExecutionEvent) => void | Promise<void>

/** Display failures must not reject or repeat an actual tool execution. */
export async function emitToolEvent(
    callback: ToolEventCallback | undefined, event: ToolExecutionEvent,
): Promise<void> {
    try {
        await callback?.(event)
    } catch (error) {
        console.error(`Tool event callback failed: ${error instanceof Error ? error.message : String(error)}`)
    }
}
