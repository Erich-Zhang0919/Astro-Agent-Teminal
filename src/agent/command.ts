import { Command } from 'commander'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'readline'
import chalk from 'chalk'
import figlet from 'figlet'
import boxen from 'boxen'
import { compactAgentContext, configuredModelId, endAgentSession, getMcpSessionStatus, runAgentStream, startAgentSession } from './agent'
import {
    ChatCommandContext,
    ChatCommandDefinition,
    createChatCommandRegistry,
    runContextCompaction,
} from './chat-commands'
import { sessionStore } from './session-store'
import { openChatTerminal } from './chat-terminal'
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
        .option('--mcp-config <path>', 'MCP Server configuration path')
        .action((opts: { hooks?: string; mcpConfig?: string }) => startInteractiveChat(opts))

    program
        .command('ask <message>')
        .description('Send a single message to the agent and print the response')
        .option('-t, --thread <id>', 'Thread ID for conversation history', randomUUID())
        .option('--hooks <path>', 'Hook configuration path')
        .option('--mcp-config <path>', 'MCP Server configuration path')
        .action(async (message: string, opts: { thread: string; hooks?: string; mcpConfig?: string }) => {
            const display = createAgentDisplay(text => { process.stdout.write(text) })
            const hookOptions = sessionHookOptions(opts.hooks, display.onHookEvent, opts.mcpConfig)
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

function sessionHookOptions(hooksPath: string | undefined, onHookEvent: ReturnType<typeof createAgentDisplay>['onHookEvent'], mcpConfigPath?: string) {
    return { hooksPath, onHookEvent, mcpConfigPath,
        onMcpDiagnostic: (message: string) => console.error(chalk.dim(message)),
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

async function reportContextUsage(
    result: AgentRunResult,
    threadId: string,
    terminal?: ReturnType<typeof openChatTerminal>,
): Promise<void> {
    const usage = formatContextUsage(result)
    if (terminal) terminal.setContext(usage)
    else process.stdout.write(`\n${chalk.dim(usage)}`)
    if (shouldWarnContextUsage(result)) {
        const warning = `[Tips]当前上下文即将达到上限，建议使用 ${chalk.bold('/new')} 开启新会话，` +
            `或使用 ${chalk.bold('/compact')} 压缩上下文。`
        if (terminal) terminal.write(warning, 'warning')
        else process.stdout.write('\n' + chalk.yellow(warning))
    }
    if (shouldAutoCompact(result)) {
        if (terminal) terminal.setActivity('Compacting context')
        else process.stdout.write('\n')
        await runContextCompaction(
            threadId,
            compactAgentContext,
            (message, level) => {
                if (terminal) terminal.write(message, level)
                else console.log(level === 'error' ? chalk.red(message) : chalk.cyan(message))
            },
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
    console.log(chalk.cyan(figlet.textSync('Astro', { font: 'Standard' })))
    console.log(chalk.bold.cyan('👋 欢迎回到 Astro！今天想一起完成什么？\n'))

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

async function startInteractiveChat(opts: { hooks?: string; mcpConfig?: string }): Promise<void> {
    const session = { threadId: randomUUID() }
    const chatCommands = createChatCommandRegistry({
        listRecentSessions: (limit) => sessionStore.listRecentSessions(limit),
        sessionExists: (threadId) => sessionStore.hasSession(threadId),
        compactContext: compactAgentContext,
        getMcpStatus: getMcpSessionStatus,
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
    const richTerminal = process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== 'dumb'
    const terminal = richTerminal ? openChatTerminal(chatCommands, pkg.version, configuredModelId) : undefined
    const display = createAgentDisplay(text => { process.stdout.write(text) }, terminal && {
        startReply: terminal.startReply,
        appendReply: terminal.appendReply,
        finishReply: terminal.finishReply,
        notice: terminal.write,
    })
    const hookOptions = sessionHookOptions(opts.hooks, display.onHookEvent, opts.mcpConfig)
    if (terminal) {
        hookOptions.onMcpDiagnostic = (message) => terminal.write(message)
        hookOptions.onHookDiagnostic = (message) => terminal.write(message, 'error')
    }
    const commandContext: ChatCommandContext = {
        session,
        writeLine: (message, level = 'info') => {
            if (terminal) terminal.write(message, level)
            else console.log(level === 'error' ? chalk.red(message) : chalk.cyan(message))
        },
    }

    let fallbackInterface: ReturnType<typeof createInterface> | undefined
    let inputClosed = false
    const readFallbackLine = (question: string) => new Promise<string | undefined>((resolve) => {
        if (inputClosed) return resolve(undefined)
        const onClose = () => resolve(undefined)
        fallbackInterface?.once('close', onClose)
        fallbackInterface?.question(question, (answer) => {
            fallbackInterface?.off('close', onClose)
            resolve(answer)
        })
    })

    let started = false
    let completed = false
    try {
        terminal?.setActivity('Opening session')
        await startAgentSession(session.threadId, { ...hookOptions, reason: 'startup' })
        started = true
        if (!terminal) {
            fallbackInterface = createInterface({ input: process.stdin, output: process.stdout })
            fallbackInterface.once('close', () => { inputClosed = true })
            printBanner(chatCommands.list())
        }

        while (true) {
            const answer = terminal ? await terminal.readInput() : await readFallbackLine('You: ')
            const input = answer ?? 'exit'
            if (!input.trim()) continue
            if (input.trim().toLowerCase() === 'exit') {
                if (terminal) {
                    terminal.setActivity(undefined)
                    terminal.write('Goodbye!')
                } else console.log(chalk.gray('Goodbye!'))
                completed = true
                break
            }
            terminal?.write(input, 'user')
            if (input.trimStart().startsWith('/')) {
                terminal?.setActivity('Running command')
                const previousThreadId = session.threadId
                if (await chatCommands.dispatch(input, commandContext)) {
                    if (previousThreadId !== session.threadId) terminal?.setContext(undefined)
                    continue
                }
            }

            fallbackInterface?.pause()
            const controller = new AbortController()
            const cancel = () => {
                if (controller.signal.aborted) return
                controller.abort()
                terminal?.setActivity('Cancelling request', cancel)
            }
            terminal?.setActivity('Waiting for Astro', cancel)
            let replying = false
            if (!terminal) process.stdout.write('\n')
            try {
                const result = await runAgentStream(
                    input,
                    (token) => {
                        if (controller.signal.aborted) return
                        if (!replying) {
                            replying = true
                            terminal?.setActivity('Astro is replying', cancel)
                        }
                        display.onToken(token)
                    },
                    session.threadId,
                    controller.signal,
                    {
                        ...hookOptions,
                        onToolEvent: display.onToolEvent,
                        confirmTool: async (request) => {
                            if (controller.signal.aborted) return false
                            display.finishReply()
                            return requestToolApproval(request, {
                                interactive: Boolean(process.stdin.isTTY),
                                readAnswer: terminal?.readApproval ?? readFallbackLine,
                                write: (text) => {
                                    if (terminal) terminal.write(text)
                                    else process.stdout.write(text)
                                },
                            })
                        },
                    },
                )
                display.finishReply()
                if (!controller.signal.aborted) {
                    terminal?.completeTurn()
                    await reportContextUsage(result, session.threadId, terminal)
                }
            } catch (err) {
                display.finishReply()
                if (!controller.signal.aborted) {
                    const message = err instanceof Error ? err.message : String(err)
                    if (terminal) terminal.write(`Error: ${message}`, 'error')
                    else console.error(chalk.red.bold('\nError:'), chalk.red(message))
                }
            } finally {
                if (controller.signal.aborted) {
                    if (terminal) terminal.write('[Cancelled]', 'warning')
                    else process.stdout.write(chalk.yellow('\n[Cancelled]'))
                }
                if (!terminal) process.stdout.write('\n\n')
                fallbackInterface?.resume()
            }
        }
    } finally {
        fallbackInterface?.close()
        try {
            if (started) await endAgentSession(session.threadId, completed ? 'exit' : 'error')
        } finally {
            terminal?.close()
        }
    }
}
