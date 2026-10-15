import { SubAgentQueue } from './subagent-queue'

function gate() {
    let release!: () => void
    const promise = new Promise<void>(resolve => { release = resolve })
    return { promise, release }
}

it('serializes a parent session and allows unrelated sessions to proceed', async () => {
    const queue = new SubAgentQueue()
    const firstStarted = gate()
    const finishFirst = gate()
    const secondTask = jest.fn(async () => 'second')
    const first = queue.run('parent', async () => {
        firstStarted.release()
        await finishFirst.promise
        return 'first'
    })
    await firstStarted.promise
    const second = queue.run('parent', secondTask)
    await expect(queue.run('other-parent', async () => 'independent')).resolves.toBe('independent')
    expect(secondTask).not.toHaveBeenCalled()
    finishFirst.release()
    await expect(first).resolves.toBe('first')
    await expect(second).resolves.toBe('second')
})

it('continues after a failed task and releases the completed session', async () => {
    const queue = new SubAgentQueue()
    const failed = queue.run('parent', async () => { throw new Error('failed') })
    const next = queue.run('parent', async () => 'next')
    await expect(failed).rejects.toThrow('failed')
    await expect(next).resolves.toBe('next')
    await expect(queue.run('parent', async () => 'again')).resolves.toBe('again')
})

it('cancels a waiter promptly without letting new work bypass the running task', async () => {
    const queue = new SubAgentQueue()
    const started = gate()
    const finish = gate()
    const controller = new AbortController()
    const first = queue.run('parent', async () => { started.release(); await finish.promise })
    await started.promise
    const cancelledTask = jest.fn()
    const cancelled = queue.run('parent', cancelledTask, controller.signal)
    controller.abort(new Error('cancel waiter'))
    await expect(cancelled).rejects.toThrow('cancel waiter')
    const nextTask = jest.fn(async () => 'next')
    const next = queue.run('parent', nextTask)
    await queue.run('other', async () => undefined)
    expect(cancelledTask).not.toHaveBeenCalled()
    expect(nextTask).not.toHaveBeenCalled()
    finish.release()
    await first
    await expect(next).resolves.toBe('next')
})

it('does not start a task when its signal is already aborted', async () => {
    const queue = new SubAgentQueue()
    const controller = new AbortController()
    controller.abort(new Error('already aborted'))
    const task = jest.fn()
    await expect(queue.run('parent', task, controller.signal)).rejects.toThrow('already aborted')
    expect(task).not.toHaveBeenCalled()
})
