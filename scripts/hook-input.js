/** Shared stdin/error handling for the example hooks. */
async function runHook(event, handle) {
    try {
        const chunks = []
        for await (const chunk of process.stdin) chunks.push(chunk)
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (input?.version !== 1 || input.event !== event) {
            throw new Error(`Expected a version 1 ${event} hook input.`)
        }
        await handle(input)
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
        process.exitCode = 1
    }
}

module.exports = { runHook }
