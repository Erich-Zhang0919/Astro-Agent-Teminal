// Local protocol fixture: no network services, credentials or browser dependencies.
const { createInterface } = require('node:readline')
const { createServer } = require('node:http')
const { writeFileSync } = require('node:fs')

function createHandler() {
    let count = 0
    const tools = [
        { name: 'echo', description: 'Echo a nested input.', inputSchema: {
            type: 'object', properties: { payload: { type: 'object', properties: {
                mode: { type: 'string', enum: ['one', 'two'] }, items: { type: 'array', items: { type: 'integer' } },
            }, required: ['mode', 'items'], additionalProperties: false } }, required: ['payload'], additionalProperties: false,
        } },
        ...['counter', 'error', 'structured', 'attachment', 'slow', 'disconnect', 'long', 'notify'].map(name => ({
            name, description: name, inputSchema: { type: 'object', properties: {} },
        })),
    ]
    if (process.env.MCP_FIXTURE_BAD_TOOLS) tools.push(tools[0], {
        name: 'bad', inputSchema: { type: 'object', properties: { broken: { type: 'invalid' } } },
    })
    return async (message, send) => {
        if (message.id === undefined) return
        const respond = result => send({ jsonrpc: '2.0', id: message.id,
            result: process.env.MCP_FIXTURE_MODERN && message.method !== 'server/discover'
                ? { resultType: 'complete', ...result } : result })
        if (message.method === 'server/discover' && process.env.MCP_FIXTURE_MODERN) return respond({
            supportedVersions: ['2026-07-28'], capabilities: { tools: {} },
            _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'astro-modern-test', version: '1.0.0' } },
        })
        if (message.method === 'initialize') return respond({ protocolVersion: '2025-11-25',
            serverInfo: { name: 'astro-test', version: '1.0.0' }, capabilities: { tools: { listChanged: true } } })
        if (message.method === 'tools/list') {
            const offset = Number(message.params?.cursor ?? 0)
            return respond({ tools: tools.slice(offset, offset + 2),
                ...(process.env.MCP_FIXTURE_MODERN ? { ttlMs: 0, cacheScope: 'private' } : {}),
                ...(offset + 2 < tools.length ? { nextCursor: String(offset + 2) } : {}) })
        }
        if (message.method !== 'tools/call') return send({ jsonrpc: '2.0', id: message.id,
            error: { code: -32601, message: 'Method not found' } })
        const name = message.params.name
        const text = value => respond({ content: [{ type: 'text', text: value }] })
        if (name === 'counter') return text(String(++count))
        if (name === 'echo') return text(JSON.stringify(message.params.arguments))
        if (name === 'error') return respond({ isError: true, content: [{ type: 'text', text: 'fixture tool error' }] })
        if (name === 'structured') return respond({ content: [], structuredContent: { total: 42 } })
        if (name === 'attachment') return respond({ content: [
            { type: 'image', mimeType: 'image/png', data: Buffer.from('fixture image').toString('base64') },
            { type: 'resource', resource: { uri: 'test://blob', mimeType: 'application/pdf', blob: Buffer.from('fixture pdf').toString('base64') } },
            { type: 'resource_link', uri: 'test://link', name: 'link', description: 'Do not fetch automatically' },
        ] })
        if (name === 'slow') { await new Promise(resolve => setTimeout(resolve, 300)); return text('slow complete') }
        if (name === 'long') return text('x'.repeat(60_000))
        if (name === 'notify') {
            send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
            return text('notified')
        }
        if (name === 'disconnect') return process.exit(0)
        return text('done')
    }
}

if (require.main === module) {
    if (process.env.MCP_FIXTURE_PID_FILE) writeFileSync(process.env.MCP_FIXTURE_PID_FILE, String(process.pid))
    const handle = createHandler()
    const lines = createInterface({ input: process.stdin })
    lines.on('line', line => { void handle(JSON.parse(line), value => process.stdout.write(JSON.stringify(value) + '\n')) })
    lines.on('close', () => process.exit(0))
}

module.exports = { createHandler, createServer }
