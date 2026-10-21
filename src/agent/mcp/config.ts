import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { getAstroConfigurationPath, getMCPServerConfig } from '../config'

const common = {
    enabled: z.boolean().default(true),
    autoApprove: z.array(z.string().min(1)).default([]),
    connectTimeoutMs: z.number().int().positive().default(15_000),
    callTimeoutMs: z.number().int().positive().default(60_000),
}
const serverSchema = z.union([
    z.object({ ...common, transport: z.literal('stdio').default('stdio'),
        command: z.string().min(1), args: z.array(z.string()).default([]),
        env: z.record(z.string(), z.string()).default({}), cwd: z.string().min(1).optional(),
    }).strict(),
    z.object({ ...common, transport: z.literal('streamable-http'),
        url: z.url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol)),
        headers: z.record(z.string(), z.string()).default({}),
    }).strict(),
])
const configSchema = z.object({ mcpServers: z.record(z.string().min(1), serverSchema) }).strict()

export type McpServerConfig = z.infer<typeof serverSchema>
export interface McpConfiguration { cwd: string; servers: Record<string, McpServerConfig> }

export async function loadMcpConfiguration(cwd: string, mcpConfigPath?: string): Promise<McpConfiguration> {
    const path = mcpConfigPath === undefined ? getAstroConfigurationPath() : resolve(cwd, mcpConfigPath)
    let input: unknown
    if (mcpConfigPath === undefined) {
        input = { mcpServers: getMCPServerConfig() }
    } else {
        let source: string
        try { source = await readFile(path, 'utf8') } catch {
            throw new Error(`Cannot read MCP configuration: ${path}`)
        }
        try { input = JSON.parse(source) } catch { throw new Error(`Invalid MCP JSON: ${path}`) }
    }
    const parsed = configSchema.safeParse(input)
    if (!parsed.success) {
        const locations = parsed.error.issues.map(issue => issue.path.join('.') || 'mcpServers').join(', ')
        throw new Error(`Invalid MCP configuration at ${locations}: ${path}`)
    }
    for (const server of Object.values(parsed.data.mcpServers)) {
        if (server.transport === 'stdio') server.cwd = server.cwd ? resolve(dirname(path), server.cwd) : resolve(cwd)
    }
    return { cwd: resolve(cwd), servers: parsed.data.mcpServers }
}

export function resolveMcpEnvironment(values: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [key,
        value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
            const resolved = process.env[name]
            if (resolved === undefined) throw new Error(`Missing environment variable: ${name}`)
            return resolved
        }),
    ]))
}
