export interface McpBinding {
    serverId: string
    toolName: string
    bindingFingerprint: string
}

export interface McpToolMetadata extends McpBinding {
    autoApprove: boolean
    isAvailable: () => boolean
}

export interface McpServerStatus {
    serverId: string
    transport: 'stdio' | 'streamable-http'
    status: 'disabled' | 'connected' | 'failed' | 'disconnected' | 'closed'
    tools: { name: string; originalName: string; description: string }[]
    error?: string
}

export function mcpMetadata(tool: unknown): McpToolMetadata | undefined {
    return (tool as { mcp?: McpToolMetadata } | undefined)?.mcp
}

export function mcpBindingMatches(binding: McpBinding, tool: unknown): boolean {
    const current = mcpMetadata(tool)
    return current !== undefined && current.isAvailable() &&
        current.serverId === binding.serverId && current.toolName === binding.toolName &&
        current.bindingFingerprint === binding.bindingFingerprint
}
