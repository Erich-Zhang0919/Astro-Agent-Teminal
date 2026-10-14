const { runHook } = require('./hook-input')

runHook('PreToolUse', (input) => {
    // Add project-specific checks here. Throw an error to block the tool with exit 1.
    // To inject context and continue, write to stderr and set process.exitCode = 2.
    process.stdout.write(`Checking tool: ${input.tool.name}\n`)
})
