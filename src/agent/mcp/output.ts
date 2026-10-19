import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const extensions: Record<string, string> = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
    'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'application/pdf': 'pdf',
}

/** Normalize attachments before hooks/checkpointing; binary data never reaches the text model. */
export async function normalizeMcpOutput(
    result: { content?: unknown[]; structuredContent?: unknown }, cwd: string, callId?: string,
): Promise<string> {
    const output: string[] = []
    const safeId = (callId ?? randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
    let attachment = 0
    async function save(data: string, mimeType: string): Promise<string> {
        const dir = resolve(cwd, 'tool_output')
        await mkdir(dir, { recursive: true })
        const path = resolve(dir, `mcp_${safeId}_${randomUUID()}_${attachment++}.${extensions[mimeType] ?? 'bin'}`)
        await writeFile(path, Buffer.from(data, 'base64'))
        return `Attachment (${mimeType}): ${path}`
    }
    for (const value of result.content ?? []) {
        const block = value as Record<string, unknown>
        if (block.type === 'text' && typeof block.text === 'string') output.push(block.text)
        else if ((block.type === 'image' || block.type === 'audio') && typeof block.data === 'string') {
            output.push(await save(block.data, String(block.mimeType ?? 'application/octet-stream')))
        } else if (block.type === 'resource' && block.resource && typeof block.resource === 'object') {
            const resource = block.resource as Record<string, unknown>
            if (typeof resource.blob === 'string') {
                output.push(await save(resource.blob, String(resource.mimeType ?? 'application/octet-stream')))
            } else if (typeof resource.text === 'string') output.push(`${String(resource.uri)}\n${resource.text}`)
            else output.push(`Resource: ${String(resource.uri)}`)
        } else if (block.type === 'resource_link') {
            output.push(`Resource link: ${String(block.uri)}${block.description ? `\n${block.description}` : ''}`)
        } else output.push(`Unsupported MCP content type: ${String(block.type)}`)
    }
    if (result.structuredContent !== undefined) output.push(JSON.stringify(result.structuredContent, null, 2))
    return output.join('\n\n') || '(empty MCP result)'
}
