import { clearLine, cursorTo } from 'node:readline'
import chalk from 'chalk'
import stringWidth from 'string-width'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** Animate one line in a terminal; keep redirected logs free of redraws. */
export function createTerminalProgress(
    output: NodeJS.WriteStream = process.stdout,
    log: (message: string) => void = message => console.log(message),
) {
    const animated = Boolean(output.isTTY) && process.env.TERM !== 'dumb'
    let timer: ReturnType<typeof setInterval> | undefined
    let message = ''
    let frame = 0

    const clear = () => {
        clearLine(output, 0)
        cursorTo(output, 0)
    }
    const draw = () => {
        // Leave a column spare to avoid wrapping onto a second terminal line.
        const width = Math.max(1, (output.columns || 80) - 1)
        const line = `${FRAMES[frame++ % FRAMES.length]} ${message}`
        let visible = ''
        for (const character of line) {
            if (stringWidth(visible + character) > width - 1) {
                visible += '…'
                break
            }
            visible += character
        }
        clear()
        output.write(chalk.cyan(visible))
    }
    const stop = () => {
        if (timer) {
            clearInterval(timer)
            timer = undefined
            clear()
        }
    }

    return {
        start(text: string) {
            stop()
            message = text
            frame = 0
            if (animated) {
                draw()
                timer = setInterval(draw, 80)
                timer.unref()
            } else {
                log(`⏳ ${text}`)
            }
        },
        update(text: string) {
            message = text
            if (timer) draw()
        },
        note(text: string) {
            if (timer) clear()
            log(text)
            if (timer) draw()
        },
        succeed(text: string) {
            stop()
            log(chalk.green(`✅ ${text}`))
        },
        fail(text: string) {
            stop()
            log(chalk.red(`❌ ${text}`))
        },
    }
}
