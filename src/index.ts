#!/usr/bin/env node
import './agent/env'
import { runCli } from './agent/cli'

runCli(process.argv).catch((error: unknown) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
})
