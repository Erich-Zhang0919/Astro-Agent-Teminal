import { runJsFn } from './run_js'
import * as runJs from './run_js'

afterEach(() => {
    runJs._cfg.nodeCommand = 'node'
})

describe('runJsFn', () => {
    it('executes a simple console.log and returns stdout', async () => {
        const result = await runJsFn({ code: 'console.log("hello world")' })
        expect(result.trim()).toBe('hello world')
    })

    it('returns the result of a computation via console.log', async () => {
        const result = await runJsFn({ code: 'console.log(2 + 3 * 4)' })
        expect(result.trim()).toBe('14')
    })

    it('executes multi-line code', async () => {
        const code = [
            'const arr = [1, 2, 3, 4, 5]',
            'const sum = arr.reduce((a, b) => a + b, 0)',
            'console.log(sum)',
        ].join('\n')
        const result = await runJsFn({ code })
        expect(result.trim()).toBe('15')
    })

    it('returns (no output) when code produces no output', async () => {
        const result = await runJsFn({ code: 'const x = 1 + 1' })
        expect(result).toBe('(no output)')
    })

    it('returns error message for a runtime error', async () => {
        const result = await runJsFn({ code: 'null.property' })
        expect(result).toMatch(/Error/i)
        expect(result).toMatch(/null/i)
    })

    it('returns error message for a syntax error', async () => {
        const result = await runJsFn({ code: 'this is not valid js !!!' })
        expect(result).toMatch(/Error/i)
    })

    it('captures stderr output', async () => {
        const result = await runJsFn({ code: 'process.stderr.write("err output\\n")' })
        expect(result).toContain('err output')
    })

    it('returns node-not-found message when node is unavailable', async () => {
        runJs._cfg.nodeCommand = 'nonexistent_node_binary_xyz'
        const result = await runJsFn({ code: 'console.log("hi")' })
        expect(result).toMatch(/Node\.js is not installed/i)
    })
})
