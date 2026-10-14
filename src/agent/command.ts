import { Command } from 'commander'
import { randomUUID } from 'node:crypto'
import { createInterface, emitKeypressEvents } from 'readline'
import chalk from 'chalk'
import figlet from 'figlet'
import boxen from 'boxen'
import { compactAgentContext, endAgentSession, runAgentStream, startAgentSession } from './agent'
import {
    ChatCommandContext,
    ChatCommandDefinition,
    createChatCommandRegistry,
    runContextCompaction,
} from './chat-commands'
import { sessionStore } from './session-store'
import { promptWithSuggestions } from './chat-prompt'
import { AgentRunResult, formatContextUsage, shouldAutoCompact, shouldWarnContextUsage } from './context-usage'
import { requestToolApproval } from './tool-approval'
import { createAgentDisplay } from './tool-display'

import pkg from '../../package.json'

export function buildProgram(): Command {
    const program = new Command()

    program
        .name('astro')
        .description(pkg.description || 'Astro AI Agent')
        .version(pkg.version)

    program
        .command('chat')
        .description('Start an interactive chat session with the agent')
        .option('--hooks <path>', 'Hook configuration path')
        .action((opts: { hooks?: string }) => startInteractiveChat(opts))

    program
        .command('ask <message>')
        .description('Send a single message to the agent and print the response')
        .option('-t, --thread <id>', 'Thread ID for conversation history', randomUUID())
        .option('--hooks <path>', 'Hook configuration path')
        .action(async (message: string, opts: { thread: string; hooks?: string }) => {
            const display = createAgentDisplay(text => { process.stdout.write(text) })
            const hookOptions = sessionHookOptions(opts.hooks, display.onHookEvent)
            await startAgentSession(opts.thread, { ...hookOptions, reason: 'ask' })
            let completed = false
            try {
                const result = await runAgentStream(
                    message,
                    display.onToken,
                    opts.thread,
                    undefined,
                    {
                        ...hookOptions,
                        onToolEvent: display.onToolEvent,
                        confirmTool: (request) => requestToolApproval(request, {
                            interactive: Boolean(process.stdin.isTTY),
                            readAnswer: readConfirmationLine,
                            write: (text) => process.stdout.write(text),
                        }),
                    },
                )
                display.finishReply()
                await reportContextUsage(result, opts.thread)
                process.stdout.write('\n')
                completed = true
            } finally {
                display.finishReply()
                await endAgentSession(opts.thread, completed ? 'ask_completed' : 'error')
            }
        })

    return program
}

function sessionHookOptions(hooksPath: string | undefined, onHookEvent: ReturnType<typeof createAgentDisplay>['onHookEvent']) {
    return { hooksPath, onHookEvent,
        onHookDiagnostic: (message: string) => console.error(chalk.red(message)) }
}

function readConfirmationLine(question: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        const input = createInterface({ input: process.stdin, output: process.stdout })
        input.once('close', () => resolve(undefined))
        input.question(question, (answer) => {
            resolve(answer)
            input.close()
        })
    })
}

const INFO_LABEL_WIDTH = 'Description'.length
const INFO_VALUE_WIDTH = 50

async function reportContextUsage(result: AgentRunResult, threadId: string): Promise<void> {
    process.stdout.write(`\n${chalk.dim(formatContextUsage(result))}`)
    if (shouldWarnContextUsage(result)) {
        process.stdout.write('\n' + chalk.yellow(
            `[Tips]当前上下文即将达到上限，建议使用 ${chalk.bold('/new')} 开启新会话，` +
            `或使用 ${chalk.bold('/compact')} 压缩上下文。`,
        ))
    }
    if (shouldAutoCompact(result)) {
        process.stdout.write('\n')
        await runContextCompaction(
            threadId,
            compactAgentContext,
            (message, level) => console.log(level === 'error' ? chalk.red(message) : chalk.cyan(message)),
            'Context usage reached 90%. Starting automatic compaction…',
        )
    }
}

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

function printBanner(chatCommands: ChatCommandDefinition[]): void {
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

    const commandUsageWidth = Math.max(...chatCommands.map(({ usage }) => usage.length))
    const usage = [
        chalk.bold('Commands:'),
        `  ${chalk.cyan('astro chat')}              Start an interactive chat session`,
        `  ${chalk.cyan('astro ask <message>')}     Send a single message and print the response`,
        '',
        chalk.bold('Chat commands:'),
        ...chatCommands.map(({ usage, description }) =>
            `  ${chalk.cyan(usage.padEnd(commandUsageWidth))}  ${description}`,
        ),
        '',
        `  ${chalk.yellow.bold('ESC')}    Cancel the current AI request`,
        `  ${chalk.green.bold('exit')}   Quit the console`,
    ].join('\n')

    console.log(usage + '\n')
}

async function startInteractiveChat(opts: { hooks?: string }): Promise<void> {
    const session = { threadId: randomUUID() }
    const display = createAgentDisplay(text => { process.stdout.write(text) })
    const hookOptions = sessionHookOptions(opts.hooks, display.onHookEvent)
    await startAgentSession(session.threadId, { ...hookOptions, reason: 'startup' })
    const chatCommands = createChatCommandRegistry({
        listRecentSessions: (limit) => sessionStore.listRecentSessions(limit),
        sessionExists: (threadId) => sessionStore.hasSession(threadId),
        compactContext: compactAgentContext,
        switchSession: async (from, to, reason) => {
            if (from === to) return
            await startAgentSession(to, { ...hookOptions, reason })
            try {
                await endAgentSession(from, 'switch')
            } catch (error) {
                await endAgentSession(to, 'error')
                throw error
            }
        },
    })
    const commandContext: ChatCommandContext = {
        session,
        writeLine: (message, level = 'info') => {
            console.log(level === 'error' ? chalk.red(message) : chalk.cyan(message))
        },
    }
    const isTTY = Boolean(process.stdin.isTTY)
    const fallbackInterface = isTTY
        ? undefined
        : createInterface({ input: process.stdin, output: process.stdout })
    let inputClosed = false
    fallbackInterface?.once('close', () => { inputClosed = true })
    const prompt = () => isTTY
        ? promptWithSuggestions(chatCommands)
        : new Promise<string>((resolve) => {
            if (inputClosed) return resolve('exit')
            const onClose = () => resolve('exit')
            fallbackInterface?.once('close', onClose)
            fallbackInterface?.question('You: ', (answer) => {
                fallbackInterface.off('close', onClose)
                resolve(answer)
            })
        })

    if (isTTY) emitKeypressEvents(process.stdin)

    printBanner(chatCommands.list())

    let completed = false
    try {
        while (true) {
            const input = await prompt()
            if (!input.trim()) continue
            if (isTTY) process.stdout.write(`${chalk.green.bold('You: ')}${input}\n`)
            if (input.trim().toLowerCase() === 'exit') {
                console.log(chalk.gray('Goodbye!'))
                completed = true
                break
            }
            if (await chatCommands.dispatch(input, commandContext)) {
                continue
            }

            fallbackInterface?.pause()

            const controller = new AbortController()

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

            process.stdout.write(chalk.dim('\n(Press ESC to cancel)\n'))

            try {
                const result = await runAgentStream(
                    input,
                    display.onToken,
                    session.threadId,
                    controller.signal,
                    {
                        ...hookOptions,
                        onToolEvent: display.onToolEvent,
                        confirmTool: async (request) => {
                            if (isTTY) {
                                process.stdin.off('keypress', onKeypress)
                                process.stdin.setRawMode(false)
                            }
                            try {
                                return await requestToolApproval(request, {
                                    interactive: isTTY,
                                    readAnswer: readConfirmationLine,
                                    write: (text) => process.stdout.write(text),
                                })
                            } finally {
                                if (isTTY) {
                                    process.stdin.setRawMode(true)
                                    process.stdin.resume()
                                    process.stdin.on('keypress', onKeypress)
                                }
                            }
                        },
                    },
                )
                if (controller.signal.aborted) {
                    process.stdout.write(chalk.yellow('\n[Cancelled]'))
                } else {
                    display.finishReply()
                    await reportContextUsage(result, session.threadId)
                }
            } catch (err) {
                if (!controller.signal.aborted) {
                    console.error(chalk.red.bold('\nError:'), chalk.red((err as Error).message))
                } else {
                    process.stdout.write(chalk.yellow('\n[Cancelled]'))
                }
            } finally {
                display.finishReply()
                if (isTTY) {
                    process.stdin.off('keypress', onKeypress)
                    process.stdin.setRawMode(false)
                }
            }

            process.stdout.write('\n\n')
            fallbackInterface?.resume()
        }
    } finally {
        fallbackInterface?.close()
        await endAgentSession(session.threadId, completed ? 'exit' : 'error')
    }
}
