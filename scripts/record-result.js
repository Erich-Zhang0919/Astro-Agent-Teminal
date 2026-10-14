const { runHook } = require('./hook-input')

runHook('PostToolUse', (input) => {
    // Add project-specific result handling here; the complete output is in input.result.content.
    process.stdout.write(`Tool completed: ${input.tool.name} (${input.result.status})\n`)
})
