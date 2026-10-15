/** Serializes child runs per parent session without coupling unrelated sessions. */
export class SubAgentQueue {
    private readonly tails = new Map<string, Promise<void>>()

    async run<T>(sessionId: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        signal?.throwIfAborted()
        const previous = this.tails.get(sessionId) ?? Promise.resolve()
        let release!: () => void
        const slot = new Promise<void>(resolve => { release = resolve })
        const tail = previous.then(() => slot)
        this.tails.set(sessionId, tail)
        // A cancelled waiter still reserves its place until earlier work settles.
        void tail.then(() => {
            if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId)
        })
        try {
            await waitForTurn(previous, signal)
            signal?.throwIfAborted()
            return await task()
        } finally {
            release()
        }
    }
}

async function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return previous
    signal.throwIfAborted()
    let onAbort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
        await Promise.race([previous, cancelled])
    } finally {
        signal.removeEventListener('abort', onAbort)
    }
}
