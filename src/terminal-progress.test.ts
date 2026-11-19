import { PassThrough } from 'node:stream'
import stringWidth from 'string-width'
import { createTerminalProgress } from './terminal-progress'

const originalTerm = process.env.TERM

beforeEach(() => {
    jest.useFakeTimers()
    process.env.TERM = 'xterm-256color'
})

afterEach(() => {
    jest.useRealTimers()
    if (originalTerm === undefined) delete process.env.TERM
    else process.env.TERM = originalTerm
})

function terminal(isTTY = true, columns = 80) {
    const output = Object.assign(new PassThrough(), { isTTY, columns }) as unknown as NodeJS.WriteStream
    const writes: string[] = []
    output.on('data', chunk => writes.push(chunk.toString()))
    const log = jest.fn()
    return { writes, log, progress: createTerminalProgress(output, log) }
}

it.each(['succeed', 'fail'] as const)('animates and updates one line, then clears its timer on %s', finish => {
    const { writes, log, progress } = terminal()
    progress.start('🧩 正在安装 skills')
    expect(writes.join('')).toContain('⠋')
    jest.advanceTimersByTime(80)
    expect(writes.join('')).toContain('⠙')
    progress.update('🧩 skill-creator (2/18) SKILL.md')
    expect(writes.join('')).toContain('(2/18) SKILL.md')
    progress.note('📦 find-skills 安装完成')
    expect(log).toHaveBeenCalledWith('📦 find-skills 安装完成')
    expect(jest.getTimerCount()).toBe(1)
    progress[finish]('安装结束')
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining(finish === 'succeed' ? '✅' : '❌'))
    expect(jest.getTimerCount()).toBe(0)
    const count = writes.length
    jest.advanceTimersByTime(500)
    expect(writes).toHaveLength(count)
})

it('replaces the previous animation when starting the next step', () => {
    const { progress } = terminal()
    progress.start('步骤一')
    progress.start('步骤二')
    expect(jest.getTimerCount()).toBe(1)
    progress.succeed('完成')
    expect(jest.getTimerCount()).toBe(0)
})

it.each([false, true])('uses static summaries for redirected output or a dumb terminal (TTY=%s)', isTTY => {
    if (isTTY) process.env.TERM = 'dumb'
    const { progress, log, writes } = terminal(isTTY)
    progress.start('正在安装')
    progress.update('file 1/18')
    progress.update('file 2/18')
    jest.advanceTimersByTime(500)
    progress.succeed('安装完成')
    expect(log.mock.calls.flat().join('\n')).toContain('⏳ 正在安装')
    expect(log.mock.calls.flat().join('\n')).not.toContain('file')
    expect(writes).toEqual([])
    expect(jest.getTimerCount()).toBe(0)
})

it('keeps long Chinese and emoji messages on one line in a narrow terminal', () => {
    const { progress, writes } = terminal(true, 24)
    progress.start('🧩 正在下载 skill-creator (18/18) scripts/很长的文件名称.py')
    const rendered = writes.join('').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    expect(rendered).toContain('…')
    expect(stringWidth(rendered)).toBeLessThanOrEqual(23)
    expect(rendered).not.toContain('\n')
    progress.succeed('完成')
})
