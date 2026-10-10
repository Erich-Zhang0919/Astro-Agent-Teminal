import * as fs from 'node:fs'
import * as path from 'node:path'
import { decideExecPermission, EXEC_DIRECTORY_MESSAGE, isCommandInProjectDir } from './exec'
import { permissionLevelOf, withPermissionLevel } from './util'

describe('exec permission', () => {
    let root: string
    let project: string

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(process.cwd(), '.exec-permission-'))
        project = path.join(root, 'project')
        fs.mkdirSync(path.join(project, 'sub dir'), { recursive: true })
        fs.mkdirSync(path.join(root, 'outside'))
        fs.symlinkSync(path.join(root, 'outside'), path.join(project, 'outside-link'))
        fs.symlinkSync(project, path.join(project, 'root-link'))
        fs.symlinkSync(path.join(root, 'outside'), path.join(project, 'outside=link'))
    })

    afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

    it.each([
        'npm test',
        'cd . && pwd',
        'cd "sub dir" && cd .. && pwd',
        '(cd "sub dir" && pwd); cd "sub dir"',
        'printf "%s" hello',
        "sh -c 'cd \"sub dir\" && pwd'",
        "env sh -c 'pwd'",
        "env -u HOME sh -c 'pwd'",
        "env -C 'sub dir' sh -c 'pwd'",
    ])('requires approval for a project command: %s', (command) => {
        expect(isCommandInProjectDir(command, project)).toBe(true)
        expect(decideExecPermission({ command }, project)).toEqual({ kind: 'confirm' })
    })

    it.each([
        'cd .. && pwd',
        'cd /tmp; pwd',
        'cd "sub dir" && cd ../.. && pwd',
        'cd ..; cd project',
        'pwd\ncd ..',
        'cd',
        'cd -',
        'cd "$HOME"',
        'cd $(printf ..)',
        'cd `printf ..`',
        'cat ../secret.txt',
        'cat outside-link/file.txt',
        'cat outside-link',
        'cat outside-link/../project/local.txt',
        'cat root-link/../outside/file.txt',
        'cd -P root-link && cd ..',
        'cd missing; cd ..',
        'cd outside-link',
        'cd outside=link',
        'cat outside=link/file.txt',
        'echo hello > ../outside.txt',
        'git -C .. status',
        'git -C.. status',
        "sh -c 'cd .. && pwd'",
        "env sh -c 'cd ..'",
        "env -C .. pwd",
        "env -C.. pwd",
        "env -u HOME sh -c 'cd ..'",
        "env -C 'sub dir' sh -c 'cd ../..'",
        'eval "cd .."',
        "cd 'unterminated",
        'cat <<EOF\ncd ..\nEOF',
        '',
    ])('blocks directory escapes or indeterminate commands: %s', (command) => {
        expect(isCommandInProjectDir(command, project)).toBe(false)
        expect(decideExecPermission({ command }, project)).toMatchObject({ kind: 'block' })
    })

    it('uses path boundaries, including absolute paths and sibling names', () => {
        expect(isCommandInProjectDir(`cd '${project}' && pwd`, project)).toBe(true)
        expect(isCommandInProjectDir(`cd '${project}-other' && pwd`, project)).toBe(false)
        expect(isCommandInProjectDir(`cat '${root}/outside/file.txt'`, project)).toBe(false)
    })

    it('blocks missing and malformed command arguments', () => {
        expect(decideExecPermission({}, project)).toEqual({ kind: 'block', message: EXEC_DIRECTORY_MESSAGE })
        expect(decideExecPermission({ command: 123 }, project)).toEqual({ kind: 'block', message: EXEC_DIRECTORY_MESSAGE })
    })

    it.each([
        'python script.py',
        'python3.13 -c "print(1)"',
        'pypy3 script.py',
        '/usr/bin/python3 ../script.py',
        'python3 -c "print(\'$HOME\')"',
        'python3 <<EOF\nprint(1)\nEOF',
        './script.py',
        'MODE=test command python3 script.py',
        'env -u HOME python3 script.py',
        'env -C . python3 script.py',
        "env -S 'python3 script.py'",
        'timeout 5 python3 script.py',
        'nice -n 5 python3 script.py',
        'pwd && python3 script.py',
        'printf hello | python3 script.py',
        "bash -c 'python3 script.py'",
        "sh -c 'env python3 script.py'",
        'if true; then python3 script.py; fi',
        'f() { python3 script.py; }; f',
        'uv run script.py',
        'poetry run python script.py',
        'pipenv run python script.py',
    ])('blocks Python and directs the model to run_py: %s', (command) => {
        expect(decideExecPermission({ command }, project)).toEqual({
            kind: 'block',
            message: 'Blocked: Python scripts cannot run through exec. Use the run_py tool instead.',
        })
    })

    it.each([
        'node script.js',
        'nodejs -e "console.log(1)"',
        '/usr/local/bin/node script.mjs',
        './script.cjs',
        './script.ts',
        'tsx script.ts',
        'ts-node script.ts',
        'ts-node-esm script.ts',
        'bun run script.ts',
        'deno run script.ts',
        'npx --yes tsx script.ts',
        'npm exec -- node script.js',
        'pnpm dlx tsx script.ts',
        'yarn exec ts-node script.ts',
        "bash -lc 'node script.js'",
        "sh -c 'npx tsx script.ts'",
        'env node script.js',
    ])('blocks JS/TS and directs the model to run_js: %s', (command) => {
        expect(decideExecPermission({ command }, project)).toEqual({
            kind: 'block',
            message: 'Blocked: JavaScript or TypeScript scripts cannot run through exec. Use the run_js tool instead.',
        })
    })

    it.each([
        'java Main.java', 'java -jar app.jar', 'javac Main.java',
        'dotnet run', 'csi script.csx', './script.cs',
        'go run main.go', 'ruby script.rb', 'ruby3.3 script.rb',
        'rustc main.rs', 'cargo run', './script.rs',
        'perl script.pl', 'php script.php', 'lua script.lua',
        'Rscript script.R', 'swift script.swift', 'julia script.jl',
        'gcc main.c', "sh -c 'ruby script.rb'",
        "awk 'BEGIN { print 1 }'", 'tclsh script.tcl',
    ])('blocks other non-shell languages: %s', (command) => {
        expect(decideExecPermission({ command }, project)).toEqual({
            kind: 'block',
            message: 'Blocked: non-shell language scripts cannot run through exec. Only shell, bash and sh scripts are permitted.',
        })
    })

    it.each([
        'command -v python3', "bash -c 'echo python'", "sh -c 'pwd'",
        'npm test', './script.sh',
    ])('preserves confirmation for shell commands and language names used as data: %s', (command) => {
        expect(decideExecPermission({ command }, project)).toEqual({ kind: 'confirm' })
    })

    it.each([
        'ls', 'ls -la', 'pwd', 'cat README.md', 'head -n 5 README.md',
        'tail -n 5 README.md', 'grep text README.md', 'find . -name README.md',
        'git status', 'git diff', 'git log --oneline -5', 'echo hello', 'date', 'whoami',
        'echo python', 'echo "node script.js"', 'cat script.py', 'cat main.go',
        'ls script.ts', 'grep python script.py', 'pwd # python script.py',
        'pwd && ls', 'cat README.md | grep text',
        "date -u '+%Y-%m-%d'", 'date -d 2026-10-09',
    ])('automatically allows safe allowlisted commands: %s', (command) => {
        expect(decideExecPermission({ command }, project)).toEqual({ kind: 'allow' })
    })

    it.each([
        'DIR /B /S', 'TYPE README.md', 'find /I "text" README.md',
        'findstr /I text README.md', 'date /T', 'WHOAMI.EXE /USER',
        'Get-ChildItem', 'Get-Location', 'Get-Content README.md',
        'Select-String text README.md', 'Write-Output hello', 'Get-Date',
        'cmd.exe /d /c "dir /b"',
        'powershell -NoProfile -NonInteractive -Command "Get-ChildItem"',
        'pwsh -NoProfile -NonInteractive -Command "Get-Content README.md"',
    ])('allows Windows read-only commands after the same checks: %s', (command) => {
        expect(decideExecPermission({ command }, project, 'win32')).toEqual({ kind: 'allow' })
    })

    it('keeps dangerous options and paths blocked despite allowlisted executable names', () => {
        for (const command of ['cat .env', 'cat ../secret.txt', 'find . -delete',
            'find . -exec rm file ;', 'git diff --output=file', 'echo hello >file',
            'date -s 2026-01-01', 'date 100917202026.00']) {
            expect(decideExecPermission({ command }, project)).toMatchObject({ kind: 'block' })
        }
        expect(decideExecPermission({ command: 'date 01-01-2026' }, project, 'win32')).toMatchObject({ kind: 'block' })
        expect(decideExecPermission({ command: 'powershell -NoProfile -NonInteractive -Command "Get-Content .env"' },
            project, 'win32')).toMatchObject({ kind: 'block' })
        for (const command of ['findstr secret .env', 'Select-String secret .env',
            'sls secret .env', 'date -r .env', 'Get-Content ../outside.txt']) {
            expect(decideExecPermission({ command }, project, 'win32')).toMatchObject({ kind: 'block' })
        }
    })

    it('keeps non-allowlisted safe commands and Windows interactive date behind approval', () => {
        for (const command of ['true', 'sed s/a/b/ README.md', 'ls && true', './ls']) {
            expect(decideExecPermission({ command }, project)).toEqual({ kind: 'confirm' })
        }
        expect(decideExecPermission({ command: 'date' }, project, 'win32')).toEqual({ kind: 'confirm' })
        expect(decideExecPermission({ command: 'cmd /c "dir /b"' }, project, 'win32')).toEqual({ kind: 'confirm' })
    })

    it.each([
        ['#!/usr/bin/env python3\nprint(1)', 'run_py'],
        ['#!/usr/bin/node\nconsole.log(1)', 'run_js'],
        ['#!/usr/bin/env -S tsx\nconsole.log(1)', 'run_js'],
        ['#!/usr/bin/ruby\nputs 1', 'non-shell'],
        ['#!/usr/bin/unknown-language\ncode', 'non-shell'],
    ])('detects extensionless executable scripts from their shebang (%s)', (content, hint) => {
        fs.writeFileSync(path.join(project, 'script'), content)
        expect(decideExecPermission({ command: './script' }, project)).toMatchObject({
            kind: 'block', message: expect.stringContaining(hint),
        })
    })

    it('preserves shell executable scripts with a shell shebang', () => {
        fs.writeFileSync(path.join(project, 'shell-script'), '#!/usr/bin/env bash\necho python')
        expect(decideExecPermission({ command: './shell-script' }, project)).toEqual({ kind: 'confirm' })
    })

    it('also inspects language execution inside local shell scripts', () => {
        fs.writeFileSync(path.join(project, 'script.sh'), '#!/bin/sh\npython3 script.py')
        expect(decideExecPermission({ command: './script.sh' }, project)).toMatchObject({
            kind: 'block', message: expect.stringContaining('run_py'),
        })
        expect(decideExecPermission({ command: 'bash script.sh' }, project)).toMatchObject({
            kind: 'block', message: expect.stringContaining('run_py'),
        })
    })

    it('recognizes exec metadata using either permission field', () => {
        expect(permissionLevelOf({ permission_tool: 'exec' })).toBe('exec')
        expect(permissionLevelOf({ permission_level: 'exec' })).toBe('exec')
        expect(withPermissionLevel({}, 'exec')).toEqual({
            permission_tool: 'exec', permission_level: 'exec',
        })
    })
})
