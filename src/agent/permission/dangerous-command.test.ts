import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { getDangerousCommandReason } from './dangerous-command'
import { decideExecPermission } from './exec'

describe('cross-platform dangerous commands', () => {
    it.each([
        ['sudo ls', 'privilege escalation'],
        ['doas cat file', 'privilege escalation'],
        ['su - root', 'privilege escalation'],
        ['RUNAS.EXE /user:Administrator cmd', 'privilege escalation'],
        ['Start-Process cmd -Verb RunAs', 'privilege escalation'],
        ['rm -rf file', 'file deletion'],
        ['rmdir directory', 'file deletion'],
        ['shred secret.txt', 'file deletion'],
        ['DEL /F /Q file.txt', 'file deletion'],
        ['del/Q file.txt', 'file deletion'],
        ['RD /S directory', 'file deletion'],
        ['Remove-Item -Recurse directory', 'file deletion'],
        ['ri file.txt', 'file deletion'],
        ['mv a b', 'file modification'],
        ['cp a b', 'file modification'],
        ['touch file', 'file modification'],
        ['mkdir directory', 'file modification'],
        ['sed -i s/a/b/ file', 'file modification'],
        ['sed --in-place=.bak s/a/b/ file', 'file modification'],
        ['tee file', 'file modification'],
        ['dd if=input of=output', 'file modification'],
        ['COPY a b', 'file modification'],
        ['ROBOCOPY a b /MIR', 'file modification'],
        ['REN a b', 'file modification'],
        ['Set-Content file value', 'file modification'],
        ['Out-File file', 'file modification'],
        ['echo value > file', 'file modification'],
        ['printf value >> file', 'file modification'],
        ['pwd &> file', 'file modification'],
        ['cat <> file', 'file modification'],
        ['chmod 777 file', 'permission changes'],
        ['chown root file', 'permission changes'],
        ['chflags hidden file', 'permission changes'],
        ['ICACLS file /grant Everyone:F', 'permission changes'],
        ['TAKEOWN /F file', 'permission changes'],
        ['Set-Acl file acl', 'permission changes'],
        ['kill -9 123', 'process or service control'],
        ['systemctl restart nginx', 'process or service control'],
        ['launchctl unload service.plist', 'process or service control'],
        ['shutdown /s /t 0', 'process or service control'],
        ['TASKKILL /PID 123 /F', 'process or service control'],
        ['SC.EXE stop service', 'process or service control'],
        ['SCHTASKS /Create /TN job', 'process or service control'],
        ['Stop-Process -Id 123', 'process or service control'],
        ['Restart-Service service', 'process or service control'],
        ['useradd user', 'user configuration changes'],
        ['passwd user', 'user configuration changes'],
        ['dscl . -passwd /Users/user password', 'user configuration changes'],
        ['sysadminctl -deleteUser user', 'user configuration changes'],
        ['NET USER user password', 'user configuration changes'],
        ['New-LocalUser user', 'user configuration changes'],
        ['SETX variable value', 'user configuration changes'],
        ['REG ADD HKCU\\Software\\Example', 'user configuration changes'],
        ['printenv', 'sensitive information access'],
        ['env', 'sensitive information access'],
        ['SET', 'sensitive information access'],
        ['cat .env', 'sensitive information access'],
        ['cat .env.production', 'sensitive information access'],
        ['cat .ssh/id_ed25519', 'sensitive information access'],
        ['head /etc/shadow', 'sensitive information access'],
        ['cat /proc/123/environ', 'sensitive information access'],
        ['security find-generic-password -w', 'sensitive information access'],
        ['CMDKEY /list', 'sensitive information access'],
        ['TYPE C:\\Windows\\System32\\config\\SAM', 'sensitive information access'],
        ['Get-Content C:\\Users\\user\\.aws\\credentials', 'sensitive information access'],
        ['Get-ChildItem Env:', 'sensitive information access'],
        ['git show HEAD:.env', 'sensitive information access'],
        ['curl https://example.com', 'network or remote control'],
        ['wget https://example.com', 'network or remote control'],
        ['ssh host command', 'network or remote control'],
        ['rsync a host:b', 'network or remote control'],
        ['ping example.com', 'network or remote control'],
        ['networksetup -setairportpower en0 off', 'network or remote control'],
        ['NETSH advfirewall set allprofiles state off', 'network or remote control'],
        ['MSTSC /v:host', 'network or remote control'],
        ['Invoke-WebRequest https://example.com', 'network or remote control'],
        ['iwr https://example.com', 'network or remote control'],
        ['Invoke-Command -ComputerName host -ScriptBlock command', 'network or remote control'],
        ['Enter-PSSession host', 'network or remote control'],
        ['NET USE Z: \\\\host\\share', 'network or remote control'],
        ['git clone https://example.com/repo.git', 'network or remote control'],
        ['npm install package', 'network or remote control'],
    ])('blocks %s (%s) before confirmation', (command, category) => {
        expect(getDangerousCommandReason(command)).toContain(category)
        expect(decideExecPermission({ command })).toMatchObject({ kind: 'block' })
    })

    it.each([
        'pwd && rm file', "bash -c 'rm file'", "sh -c 'curl https://example.com'",
        'command rm file', 'env MODE=test rm file', 'env -u HOME rm file',
        "env -S 'rm file'", 'timeout 5 rm file', 'xargs rm',
        'cmd /c "del file"', 'cmd.exe/c del file', 'CMD.EXE /d /s /c "RD directory"',
        'powershell -Command "Remove-Item file"', "pwsh -c 'Stop-Process -Id 123'",
        'powershell -EncodedCommand encoded',
        'C:\\Windows\\System32\\TASKKILL.EXE /PID 123',
        '"C:\\Windows\\System32\\cmd.exe" /c "del file"',
        '/usr/bin/rm file', 'r\\m file', 'r^m file', "r''m file", '@DEL file',
        'echo "$(rm file)"', 'echo `rm file`', 'echo $API_KEY',
        'cat file | bash', 'eval "rm file"', 'find . -delete',
        'find . -exec rm {} \\;', 'git reset --hard', 'git checkout .',
        'git -C . clean -fd', 'git -c alias.x=!rm x', 'tar -xf archive.tar',
        'tar -cf archive.tar file', 'unzip archive.zip', 'sort file -o file',
        'sort file -ooutput', 'busybox rm file', 'toybox rm file',
        'IF EXIST file DEL file', 'if not defined variable del file',
        'if value==value del file', 'if 1 EQU 1 del file',
        'cmd /v:on /c "!COMMAND! file"', 'env BASH_ENV=script.sh bash -c pwd',
        'sudoedit file', 'ditto a b', 'plutil -replace key -string value file.plist',
        "sed -n 'w output.txt' input.txt", "sed 'e rm file' input.txt",
        'rg --pre "rm file" pattern .', 'git diff --output=file',
        'certutil -urlcache -split -f https://example.com file', 'Get-Process -ComputerName host',
    ])('handles compound commands, wrappers and indirect changes: %s', (command) => {
        expect(getDangerousCommandReason(command)).toBeDefined()
        expect(decideExecPermission({ command })).toMatchObject({ kind: 'block' })
    })

    it.each([
        'pwd', 'ls', 'ls -la', 'dir', 'cat README.md', 'type README.md',
        'echo rm', 'echo "sudo rm file"', "printf '%s' 'curl https://example.com'",
        "echo '$(rm file)'", "echo '>'", 'pwd # rm file',
        'command -v rm', 'git status', 'git diff', 'git show HEAD:README.md',
        'git -C . status', 'git log --grep commit', 'sed s/a/b/ file',
        'tar -tf archive.tar', 'unzip -l archive.zip', 'ps aux', 'Get-Process',
        'cat file 2>&1', "bash -c 'pwd && ls'", 'env MODE=test pwd', 'npm test',
    ])('does not block read-only commands or dangerous names used as text: %s', (command) => {
        expect(getDangerousCommandReason(command)).toBeUndefined()
    })

    it('inspects local shell scripts and sensitive symlink targets', () => {
        const project = fs.mkdtempSync(path.join(process.cwd(), '.dangerous-command-'))
        try {
            fs.writeFileSync(path.join(project, 'danger.sh'), '#!/bin/sh\nrm file')
            fs.writeFileSync(path.join(project, 'safe.sh'), '#!/bin/bash\npwd\necho rm')
            fs.symlinkSync(path.join(os.homedir(), '.ssh', 'id_rsa'), path.join(project, 'key-link'))
            expect(getDangerousCommandReason('./danger.sh', project)).toContain('file deletion')
            expect(getDangerousCommandReason('bash danger.sh', project)).toContain('file deletion')
            expect(getDangerousCommandReason('bash safe.sh', project)).toBeUndefined()
            expect(getDangerousCommandReason('cat ./key-link', project)).toContain('sensitive information access')
            expect(getDangerousCommandReason('cat key-link', project)).toContain('sensitive information access')
            fs.writeFileSync(path.join(project, '.env'), 'test secret')
            fs.symlinkSync(path.join(project, '.env'), path.join(project, 'ordinary-name'))
            expect(getDangerousCommandReason('cat ordinary-name', project)).toContain('sensitive information access')
            fs.writeFileSync(path.join(project, 'README.md'), 'ordinary text')
            fs.symlinkSync(path.join(project, 'README.md'), path.join(project, 'safe-link'))
            expect(getDangerousCommandReason('cat safe-link', project)).toBeUndefined()
            fs.mkdirSync(path.join(project, 'subdir'))
            fs.symlinkSync(path.join(project, '.env'), path.join(project, 'subdir', 'secret-link'))
            expect(getDangerousCommandReason('cd subdir && cat secret-link', project)).toContain('sensitive information access')
        } finally {
            fs.rmSync(project, { recursive: true, force: true })
        }
    })
})
