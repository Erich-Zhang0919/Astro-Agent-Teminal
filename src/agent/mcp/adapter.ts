import { createHash } from 'node:crypto'
import { tool, type ToolRuntime, type ToolSchemaBase } from '@langchain/core/tools'
import { ToolMessage } from '@langchain/core/messages'
import type { CallToolResult, Tool, JsonSchemaType } from '@modelcontextprotocol/client'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv'
import { withPermissionLevel } from '../permission/util'
import { McpToolMetadata } from './types'
import { normalizeMcpOutput } from './output'

export function fingerprint(value: unknown): string {
    function canonical(input: unknown): unknown {
        if (Array.isArray(input)) return input.map(canonical)
        if (input && typeof input === 'object') return Object.fromEntries(
            Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]))
        return input
    }
    return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

export function mcpToolName(serverId: string, originalName: string): string {
    const original = `mcp__${serverId}__${originalName}`
    if (/^[a-zA-Z0-9_-]+$/.test(original) && original.length <= 64) return original
    return `${original.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 55)}_${fingerprint([serverId, originalName]).slice(0, 8)}`
}

export function createMcpTool(
    descriptor: Tool, metadata: McpToolMetadata, cwd: string,
    invoke: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<CallToolResult>,
) {
    const validate = new AjvJsonSchemaValidator().getValidator<Record<string, unknown>>(descriptor.inputSchema as JsonSchemaType)
    const name = mcpToolName(metadata.serverId, descriptor.name)
    const item = tool(async (args: Record<string, unknown>, runtime: ToolRuntime) => {
        const signal = runtime.signal ?? runtime.config?.signal
        signal?.throwIfAborted()
        const callId = runtime.toolCallId || runtime.toolCall?.id || ''
        const respond = (content: string, status: 'success' | 'error') => new ToolMessage({
            content, status, name, tool_call_id: callId,
        })
        if (!metadata.isAvailable()) return respond('MCP Server is disconnected. Re-enter the session to reconnect.', 'error')
        if (!validate(args).valid) return respond('MCP arguments do not match the tool input schema.', 'error')
        try {
            const result = await invoke(args, signal)
            signal?.throwIfAborted()
            return respond(await normalizeMcpOutput(result, cwd, callId), result.isError ? 'error' : 'success')
        } catch (error) {
            if (signal?.aborted) throw signal.reason
            const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'request failed'
            // Server error messages may echo credentials. Only expose a bounded code.
            const safeCode = /^[A-Za-z0-9_-]{1,60}$/.test(code) ? code : 'request failed'
            return respond(`MCP request failed (${safeCode}). Execution outcome may be unknown; the call was not retried.`, 'error')
        }
    }, { name, description: descriptor.description || `Call ${descriptor.name} on MCP Server ${metadata.serverId}.`,
        schema: descriptor.inputSchema as ToolSchemaBase,
    })
    return Object.assign(withPermissionLevel(item, 'mcp'), { mcp: metadata })
}

export type McpAgentTool = ReturnType<typeof createMcpTool>
