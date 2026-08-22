import { runPyFn } from './run_py'
import * as runPy from './run_py'

afterEach(() => {
    runPy._cfg.pythonCommand = 'python3'
})

describe('runPyFn', () => {
    it('executes a simple print and returns stdout', async () => {
        const result = await runPyFn({ code: 'print("hello world")' })
        expect(result.trim()).toBe('hello world')
    })

    it('returns the result of a computation via print', async () => {
        const result = await runPyFn({ code: 'print(2 + 3 * 4)' })
        expect(result.trim()).toBe('14')
    })

    it('executes multi-line code', async () => {
        const code = [
            'arr = [1, 2, 3, 4, 5]',
            'total = sum(arr)',
            'print(total)',
        ].join('\n')
        const result = await runPyFn({ code })
        expect(result.trim()).toBe('15')
    })

    it('returns (no output) when code produces no output', async () => {
        const result = await runPyFn({ code: 'x = 1 + 1' })
        expect(result).toBe('(no output)')
    })

    it('returns error message for a runtime error', async () => {
        const result = await runPyFn({ code: 'print(undefined_name)' })
        expect(result).toMatch(/Error/i)
        expect(result).toMatch(/NameError/i)
    })

    it('returns error message for a syntax error', async () => {
        const result = await runPyFn({ code: 'this is not valid python !!!' })
        expect(result).toMatch(/Error/i)
    })

    it('captures stderr output', async () => {
        const code = [
            'import sys',
            'sys.stderr.write("err output\\n")',
        ].join('\n')
        const result = await runPyFn({ code })
        expect(result).toContain('err output')
    })

    it('returns python-not-found message when python3 is unavailable', async () => {
        runPy._cfg.pythonCommand = 'nonexistent_python_binary_xyz'
        const result = await runPyFn({ code: 'print("hi")' })
        expect(result).toMatch(/Python 3 is not installed/i)
    })
})
