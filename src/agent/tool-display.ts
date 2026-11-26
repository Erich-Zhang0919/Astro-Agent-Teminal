import chalk from 'chalk'
import type { ToolExecutionEvent } from './tool-events'
import type { HookExecutionEvent } from './hooks'

interface AgentDisplaySink {
    startReply: () => void
    appendReply: (text: string) => void
    finishReply: () => void
    notice: (text: string, tone?: 'error' | 'info') => void
}

function compact(text: string, limit: number): string {
    const line = text.replace(/\s+/g, ' ').trim()
    return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

/** Keeps terminal notices separate from streamed assistant reply text. */
export function createAgentDisplay(write: (text: string) => void, sink?: AgentDisplaySink) {
    const output = sink ?? {
        startReply: () => write(chalk.blue.bold('Astro: ')),
        appendReply: write,
        finishReply: () => write('\n'),
        notice: (text: string) => write(`${text}\n`),
    }
    let replying = false
    const finishReply = () => {
        if (replying) output.finishReply()
        replying = false
    }
    return {
        finishReply,
        onToken(token: string): void {
            if (!replying) {
                output.startReply()
                replying = true
            }
            output.appendReply(token)
        },
        onToolEvent(event: ToolExecutionEvent): void {
            // Successful calls need only one line; results still reach the model intact.
            if (event.type === 'result' && event.status === 'success') return
            finishReply()
            if (event.type === 'start') {
                const args = compact(JSON.stringify(event.args), 120)
                output.notice(`${chalk.magenta('[Tool]')} ${chalk.yellow(event.name)} called: ${chalk.cyan(args)}`)
            } else {
                const status = event.status === 'blocked'
                    ? `Blocked [${event.reason.source}/${event.reason.code}]: ${compact(event.reason.message.replace(/^Blocked:\s*/, ''), 180)}`
                    : 'Error'
                output.notice(chalk.red(`[Tool] ${event.name}: ${status}`), 'error')
            }
        },
        onHookEvent(event: HookExecutionEvent): void {
            if (!event.stdout && !event.stderr) return
            finishReply()
            for (const [text, color, tone] of [
                [event.stdout, chalk.dim, 'info'], [event.stderr, chalk.red, 'error'],
            ] as const) {
                if (!text) continue
                const lines = text.replace(/\r\n/g, '\n').split('\n')
                if (lines[lines.length - 1] === '') lines.pop()
                for (const line of lines) output.notice(`${color(`[Hook ${event.event}]`)} ${line}`, tone)
            }
        },
    }
}
