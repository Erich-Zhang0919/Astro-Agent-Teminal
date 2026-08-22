import { Command } from 'commander'
import { emitKeypressEvents } from 'readline'
import chalk from 'chalk'
import figlet from 'figlet'
import boxen from 'boxen'
import { runAgentStream } from './agent'

import pkg from '../../package.json'

const THREAD_ID = 'user-session-1'

export function buildProgram(): Command {
    const program = new Command()

    program
        .name('astro')
        .description(pkg.description || 'Astro AI Agent')
        .version(pkg.version)

    program
        .command('chat')
        .description('Start an interactive chat session with the agent')
        .action(startInteractiveChat)

    program
        .command('ask <message>')
        .description('Send a single message to the agent and print the response')
        .option('-t, --thread <id>', 'Thread ID for conversation history', THREAD_ID)
        .action(async (message: string, opts: { thread: string }) => {
            process.stdout.write(chalk.blue.bold('AI: '))
            await runAgentStream(message, (token) => process.stdout.write(token), opts.thread)
            process.stdout.write('\n')
        })

    return program
}

const INFO_LABEL_WIDTH = 'Description'.length
const INFO_VALUE_WIDTH = 50

function wrapText(text: string, width: number): string[] {
    const words = text.split(' ')
    const lines: string[] = []
    let line = ''
    for (const word of words) {
        const candidate = line ? `${line} ${word}` : word
        if (candidate.length > width) {
            if (line) lines.push(line)
            line = word
        } else {
            line = candidate
        }
    }
    if (line) lines.push(line)
    return lines
}

function printBanner(): void {
    const displayName = pkg.name
        .split(/[-_]/)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')

    console.log(chalk.cyan(figlet.textSync(displayName, { font: 'Standard' })))

    const pad = (label: string) => label.padEnd(INFO_LABEL_WIDTH)
    const indent = ' '.repeat(INFO_LABEL_WIDTH + 1)
    const descLines = wrapText(pkg.description, INFO_VALUE_WIDTH)

    const info = [
        `${chalk.bold(pad('Version'))} ${pkg.version}`,
        `${chalk.bold(pad('Description'))} ${descLines[0]}`,
        ...descLines.slice(1).map((line) => `${indent}${line}`),
        `${chalk.bold(pad('Author'))} ${pkg.author}`,
        `${chalk.bold(pad('Docs'))} ${pkg.docs}`,
    ].join('\n')

    console.log(
        boxen(info, {
            padding: 1,
            margin: { top: 0, bottom: 1, left: 0, right: 0 },
            borderStyle: 'round',
            borderColor: 'cyan',
        }),
    )

    const usage = [
        chalk.bold('Commands:'),
        `  ${chalk.cyan('astro chat')}              Start an interactive chat session`,
        `  ${chalk.cyan('astro ask <message>')}     Send a single message and print the response`,
        '',
        `  ${chalk.yellow.bold('ESC')}    Cancel the current AI request`,
        `  ${chalk.green.bold('exit')}   Quit the console`,
    ].join('\n')

    console.log(usage + '\n')
}

async function startInteractiveChat(): Promise<void> {
    const { createInterface } = await import('readline')

    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const prompt = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve))

    emitKeypressEvents(process.stdin)

    printBanner()

    while (true) {
        const input = await prompt(chalk.green.bold('You: '))
        if (!input.trim()) continue
        if (input.toLowerCase() === 'exit') {
            console.log(chalk.gray('Goodbye!'))
            rl.close()
            break
        }

        rl.pause()

        const controller = new AbortController()
        const isTTY = process.stdin.isTTY

        const onKeypress = (_str: string | undefined, key: { name: string }) => {
            if (key?.name === 'escape') {
                controller.abort()
            }
        }

        if (isTTY) {
            process.stdin.setRawMode(true)
            process.stdin.resume()
            process.stdin.on('keypress', onKeypress)
        }

        process.stdout.write(chalk.dim('\n(Press ESC to cancel)\n') + chalk.blue.bold('AI: '))

        try {
            await runAgentStream(input, (token) => process.stdout.write(token), THREAD_ID, controller.signal)
            if (controller.signal.aborted) {
                process.stdout.write(chalk.yellow('\n[Cancelled]'))
            }
        } catch (err) {
            if (!controller.signal.aborted) {
                console.error(chalk.red.bold('\nError:'), chalk.red((err as Error).message))
            } else {
                process.stdout.write(chalk.yellow('\n[Cancelled]'))
            }
        } finally {
            if (isTTY) {
                process.stdin.off('keypress', onKeypress)
                process.stdin.setRawMode(false)
            }
        }

        process.stdout.write('\n\n')
        rl.resume()
    }
}
