import { exec } from 'child_process'
import { execFn } from './exec'

jest.mock('child_process', () => ({
    exec: jest.fn((_command, _options, callback) => callback(new Error('Unexpected subprocess execution'))),
}))

beforeEach(() => jest.mocked(exec).mockClear())

it.each([
    'sudo ls', 'rm file', 'mv a b', 'echo value > file', 'chmod 777 file',
    'kill 123', 'passwd user', 'cat .env', 'curl https://example.com',
    'DEL /F file', 'COPY a b', 'ICACLS file /grant Everyone:F',
    'TASKKILL /PID 123', 'NET USER user password', 'CMDKEY /list',
    'powershell -Command "Invoke-WebRequest https://example.com"',
    'launchctl unload service.plist', 'security find-generic-password -w',
    "bash -c 'rm file'", 'echo "$(rm file)"', 'python3 script.py',
])('never starts a subprocess for a blocked command: %s', async (command) => {
    await expect(execFn({ command })).rejects.toThrow('Blocked:')
    expect(exec).not.toHaveBeenCalled()
})
