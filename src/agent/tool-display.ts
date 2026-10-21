import chalk from 'chalk'
import type { ToolExecutionEvent } from './tool-events'
import type { HookExecutionEvent } from './hooks'

function compact(text: string, limit: number): string {
    const line = text.replace(/\s+/g, ' ').trim()
    return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

/** Keeps terminal notices separate from streamed assistant reply text. */
export function createAgentDisplay(write: (text: string) => void) {
    let replying = false
    const finishReply = () => {
        if (replying) write('\n')
        replying = false
    }
    return {
        finishReply,
        onToken(token: string): void {
            if (!replying) {
                write(chalk.blue.bold('Astro: '))
                replying = true
            }
            write(token)
        },
        onToolEvent(event: ToolExecutionEvent): void {
            // Successful calls need only one line; results still reach the model intact.
            if (event.type === 'result' && event.status === 'success') return
            finishReply()
            if (event.type === 'start') {
                const args = compact(JSON.stringify(event.args), 120)
                write(`${chalk.magenta('[Tool]')} ${chalk.yellow(event.name)} called: ${chalk.cyan(args)}\n`)
            } else {
                write(`${chalk.red(`[Tool] ${event.name}: ${event.status === 'blocked' ? 'Blocked' : 'Error'}`)}\n`)
            }
        },
        onHookEvent(event: HookExecutionEvent): void {
            if (!event.stdout && !event.stderr) return
            finishReply()
            for (const [output, color] of [[event.stdout, chalk.dim], [event.stderr, chalk.red]] as const) {
                if (!output) continue
                const lines = output.replace(/\r\n/g, '\n').split('\n')
                if (lines[lines.length - 1] === '') lines.pop()
                for (const line of lines) write(`${color(`[Hook ${event.event}]`)} ${line}\n`)
            }
        },
    }
}
