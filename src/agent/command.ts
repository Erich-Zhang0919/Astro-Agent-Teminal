import { Command } from 'commander'
import { emitKeypressEvents } from 'readline'
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
            process.stdout.write('AI: ')
            await runAgentStream(message, (token) => process.stdout.write(token), opts.thread)
            process.stdout.write('\n')
        })

    return program
}

async function startInteractiveChat(): Promise<void> {
    const { createInterface } = await import('readline')

    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const prompt = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve))

    emitKeypressEvents(process.stdin)

    console.log('=== Astro Agent Console (type "exit" to quit) ===\n')

    while (true) {
        const input = await prompt('You: ')
        if (!input.trim()) continue
        if (input.toLowerCase() === 'exit') {
            console.log('Goodbye!')
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

        process.stdout.write('\n(Press ESC to cancel)\nAI: ')

        try {
            await runAgentStream(input, (token) => process.stdout.write(token), THREAD_ID, controller.signal)
            if (controller.signal.aborted) {
                process.stdout.write('\n[Cancelled]')
            }
        } catch (err) {
            if (!controller.signal.aborted) {
                console.error('\nError:', (err as Error).message)
            } else {
                process.stdout.write('\n[Cancelled]')
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
