#!/usr/bin/env node
import './agent/env'
import { runCli } from './agent/cli'
import { AstroConfigurationError } from './agent/config'
import chalk from 'chalk'

runCli(process.argv).catch((error: unknown) => {
    console.error(error instanceof AstroConfigurationError
        ? `\n${chalk.yellow(error.userMessage)}\n`
        : `Error: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
})
