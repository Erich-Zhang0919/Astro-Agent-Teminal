#!/usr/bin/env node
import './env'
import { buildProgram } from './command'

buildProgram().parseAsync(process.argv).catch((error: unknown) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
})
