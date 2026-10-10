import { isSafeExecCommand } from './safe-command'

describe('safe command allowlist', () => {
    it.each(['linux', 'darwin', 'win32'] as const)('recognizes common reads on %s', (platform) => {
        for (const command of ['ls', 'pwd', 'cat README.md', 'head -n 5 README.md',
            'tail README.md', 'grep text README.md', 'find . -name README.md',
            'git status', 'git diff', 'git log --oneline', 'echo hello', 'whoami',
            'command ls', 'git --no-pager log', 'git -C . status', 'pwd && ls',
            'cat README.md | grep text']) {
            expect(isSafeExecCommand(command, platform)).toBe(true)
        }
    })

    it.each([
        '', 'lsbad', './ls', '/usr/bin/ls', 'LS', 'npm test', 'true',
        'git checkout .', 'git show HEAD', 'git -c alias.x=anything status',
        'git diff --ext-diff', 'git diff --textconv', 'git log --output=file',
        'git --paginate log', 'find . -exec echo hello ;', 'find . -delete',
        'ls && true', 'ls; npm test', 'cat file | custom-reader', 'ls &',
        'echo hello > file', 'cat < file', '(ls)', 'echo $(pwd)', 'echo `pwd`',
        'MODE=test ls', 'bash -c ls', 'date -s 2026-01-01',
        'pwd &&', 'ls |', 'echo hello ||',
    ])('does not automatically allow commands outside the exact safe forms: %s', (command) => {
        expect(isSafeExecCommand(command, 'linux')).toBe(false)
    })

    it('recognizes quoting without treating quoted text as executable code', () => {
        expect(isSafeExecCommand('echo "rm file; sudo ls"', 'linux')).toBe(true)
        expect(isSafeExecCommand("echo '$(rm file)'", 'linux')).toBe(true)
        expect(isSafeExecCommand('echo ">"', 'linux')).toBe(true)
        expect(isSafeExecCommand('pwd;', 'linux')).toBe(true)
        expect(isSafeExecCommand('command '.repeat(30) + 'ls', 'linux')).toBe(false)
    })

    it('allows read-only date forms and rejects setting the date', () => {
        for (const platform of ['linux', 'darwin'] as const) {
            expect(isSafeExecCommand('date', platform)).toBe(true)
            expect(isSafeExecCommand("date -u '+%Y-%m-%d'", platform)).toBe(true)
            expect(isSafeExecCommand('date -r file', platform)).toBe(true)
            expect(isSafeExecCommand('date --set=2026-01-01', platform)).toBe(false)
        }
        expect(isSafeExecCommand('date', 'win32')).toBe(false)
        expect(isSafeExecCommand('date /T', 'win32')).toBe(true)
    })

    it('only unwraps Windows shells with profile/startup execution disabled', () => {
        expect(isSafeExecCommand('cmd /d /c "dir /b"', 'win32')).toBe(true)
        expect(isSafeExecCommand('cmd /c "dir /b"', 'win32')).toBe(false)
        expect(isSafeExecCommand('pwsh -NoProfile -NonInteractive -Command "Get-Date"', 'win32')).toBe(true)
        expect(isSafeExecCommand('pwsh -Command "Get-Date"', 'win32')).toBe(false)
        expect(isSafeExecCommand('powershell -NoProfile -NonInteractive -Command "Get-Date; Remove-Item file"', 'win32')).toBe(false)
        expect(isSafeExecCommand('cmd /d /c "dir & del file"', 'win32')).toBe(false)
        expect(isSafeExecCommand('cmd /d /c "type %PASSWORD%"', 'win32')).toBe(false)
    })
})
