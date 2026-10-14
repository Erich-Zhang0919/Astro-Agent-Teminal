const { runHook } = require('./hook-input')

runHook('SessionEnd', (input) => {
    // Add project-specific cleanup here.
    process.stdout.write(`Session ended: ${input.sessionId} (${input.reason})\n`)
})
