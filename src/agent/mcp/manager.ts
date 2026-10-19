import { Client, StreamableHTTPClientTransport, type Transport } from '@modelcontextprotocol/client'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio'
import { McpConfiguration, McpServerConfig, resolveMcpEnvironment } from './config'
import { createMcpTool, fingerprint, McpAgentTool, mcpToolName } from './adapter'
import { McpServerStatus } from './types'
import { SubAgentQueue } from '../subagent-queue'

type Connection = { client: Client; transport: Transport; status: McpServerStatus; controller: AbortController }

/** A manager owns only one parent activation; children borrow its tools. */
export class McpManager {
    readonly tools: McpAgentTool[] = []
    private readonly statuses: McpServerStatus[] = []
    private readonly connections: Connection[] = []
    private readonly queue = new SubAgentQueue()
    private closed = false
    private closing?: Promise<void>

    constructor(private readonly config: McpConfiguration,
        private readonly onDiagnostic?: (message: string) => void) {}

    private diagnose(serverId: string, message: string) {
        try { this.onDiagnostic?.(`[MCP ${serverId}] ${message}`) } catch { /* Display callbacks cannot break connections. */ }
    }

    async start(signal?: AbortSignal): Promise<void> {
        try {
            await Promise.all(Object.entries(this.config.servers).map(([serverId, server]) => this.connect(serverId, server, signal)))
            signal?.throwIfAborted()
        } catch (error) {
            await this.close()
            throw error
        }
    }

    private async connect(serverId: string, config: McpServerConfig, signal?: AbortSignal): Promise<void> {
        const status: McpServerStatus = { serverId, transport: config.transport,
            status: config.enabled ? 'failed' : 'disabled', tools: [] }
        this.statuses.push(status)
        if (!config.enabled) return
        let resolved: McpServerConfig
        try {
            resolved = config.transport === 'stdio' ? { ...config, env: resolveMcpEnvironment(config.env) }
                : { ...config, headers: resolveMcpEnvironment(config.headers) }
        } catch (error) {
            status.error = (error as Error).message
            this.diagnose(serverId, status.error)
            return
        }
        const deadline = AbortSignal.timeout(config.connectTimeoutMs)
        const controller = new AbortController()
        const connectSignal = AbortSignal.any([controller.signal, deadline, ...(signal ? [signal] : [])])
        const client = new Client({ name: 'astro', version: '1.0.0' }, {
            versionNegotiation: { mode: 'auto', probe: { timeoutMs: Math.min(2000, config.connectTimeoutMs) } },
            inputRequired: { autoFulfill: false },
            listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => {
                this.diagnose(serverId, 'Tool list changed. Re-enter the session to update tools.')
            } } },
        })
        const transport = resolved.transport === 'stdio'
            ? new StdioClientTransport({ command: resolved.command, args: resolved.args, cwd: resolved.cwd,
                env: { ...getDefaultEnvironment(), ...resolved.env }, stderr: 'pipe' })
            : new StreamableHTTPClientTransport(new URL(resolved.url), {
                requestInit: { headers: resolved.headers }, reconnectionOptions: { maxRetries: 0,
                    initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
            })
        // Drain stderr without exposing extensions' environment dumps to the terminal.
        if (transport instanceof StdioClientTransport) transport.stderr?.on('data', () => undefined)
        const connection = { client, transport, status, controller }
        this.connections.push(connection)
        client.onclose = () => {
            if (status.status === 'connected') {
                status.status = 'disconnected'
                status.error = 'Connection closed. Re-enter the session to reconnect.'
                this.diagnose(serverId, status.error)
            }
        }
        client.onerror = () => this.diagnose(serverId, 'Protocol or transport error.')
        try {
            await client.connect(transport, { signal: connectSignal, timeout: config.connectTimeoutMs })
            connectSignal.throwIfAborted()
            const descriptors = client.getServerCapabilities()?.tools
                ? (await client.listTools(undefined, { signal: connectSignal, timeout: config.connectTimeoutMs })).tools : []
            connectSignal.throwIfAborted()
            if (this.closed) throw new Error('Manager is closed')
            const duplicates = new Set(descriptors.filter((item, index, all) =>
                all.findIndex(other => other.name === item.name) !== index).map(item => item.name))
            for (const descriptor of descriptors) {
                const name = mcpToolName(serverId, descriptor.name)
                if (duplicates.has(descriptor.name) || this.tools.some(item => item.name === name)) {
                    this.diagnose(serverId, `Skipping duplicate tool: ${descriptor.name}`)
                    continue
                }
                try {
                    const item = createMcpTool(descriptor, {
                        serverId, toolName: descriptor.name,
                        bindingFingerprint: fingerprint({ serverId, config: resolved, descriptor }),
                        autoApprove: config.autoApprove.includes('*') || config.autoApprove.includes(descriptor.name),
                        isAvailable: () => !this.closed && status.status === 'connected',
                    }, this.config.cwd, (args, callSignal) => {
                        const combined = AbortSignal.any([controller.signal, ...(callSignal ? [callSignal] : [])])
                        return this.queue.run(serverId, async () => {
                            combined.throwIfAborted()
                            if (status.status !== 'connected') throw new Error('Disconnected')
                            return client.callTool({ name: descriptor.name, arguments: args }, {
                                signal: combined, timeout: config.callTimeoutMs,
                                // Pin descriptor to avoid SDK rediscovery/retry on header mismatches.
                                toolDefinition: descriptor,
                            })
                        }, combined)
                    })
                    this.tools.push(item)
                    status.tools.push({ name, originalName: descriptor.name, description: item.description })
                } catch {
                    this.diagnose(serverId, `Skipping tool with unsupported schema: ${descriptor.name}`)
                }
            }
            status.status = 'connected'
            this.diagnose(serverId, `Connected (${status.tools.length} tools).`)
        } catch {
            status.status = 'failed'
            status.error = deadline.aborted ? 'Connection or discovery timed out.' : 'Connection or discovery failed.'
            await client.close().catch(() => undefined)
            await transport.close().catch(() => undefined)
            if (signal?.aborted) return
            this.diagnose(serverId, status.error)
        }
    }

    getStatus(): McpServerStatus[] {
        return this.statuses.map(status => ({ ...status, tools: status.tools.map(tool => ({ ...tool })) }))
    }

    close(): Promise<void> {
        if (this.closing) return this.closing
        this.closed = true
        this.closing = Promise.all(this.connections.map(async ({ client, transport, status, controller }) => {
            controller.abort(new Error('MCP session closed'))
            status.status = 'closed'
            try {
                if (transport instanceof StreamableHTTPClientTransport) {
                    const timeout = AbortSignal.timeout(3000)
                    await Promise.race([transport.terminateSession(), new Promise<void>(resolve => {
                        timeout.addEventListener('abort', () => resolve(), { once: true })
                    })]).catch(() => undefined)
                }
            } finally {
                await client.close().catch(() => undefined)
                await transport.close().catch(() => undefined)
            }
        })).then(() => undefined)
        return this.closing
    }
}
