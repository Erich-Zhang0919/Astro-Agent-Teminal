const { runHook } = require('./hook-input')

runHook('SessionStart', (input) => {
    // Add project-specific session setup here. stdout is not injected into context.
    process.stdout.write(`Session started: ${input.sessionId}\n`)
})
