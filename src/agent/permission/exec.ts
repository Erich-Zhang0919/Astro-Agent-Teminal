import * as fs from 'node:fs'
import * as path from 'node:path'
import { isInProjectDir, PermissionDecision } from './util'
import { getDangerousCommandReason } from './dangerous-command'
import { isSafeExecCommand, isWindowsReadSwitch } from './safe-command'

export const EXEC_DIRECTORY_MESSAGE =
    'Blocked: command leaves the current project directory or its paths cannot be safely determined.'

const LANGUAGE_MESSAGES = {
    python: 'Blocked: Python scripts cannot run through exec. Use the run_py tool instead.',
    javascript: 'Blocked: JavaScript or TypeScript scripts cannot run through exec. Use the run_js tool instead.',
    other: 'Blocked: non-shell language scripts cannot run through exec. Only shell, bash and sh scripts are permitted.',
} as const

type ScriptLanguage = keyof typeof LANGUAGE_MESSAGES

const OTHER_LANGUAGE_COMMANDS = new Set([
    'java', 'javac', 'jshell', 'dotnet', 'csi', 'csc', 'mcs', 'mono',
    'go', 'ruby', 'irb', 'rustc', 'cargo', 'perl', 'php', 'lua', 'luajit',
    'R', 'Rscript', 'swift', 'kotlin', 'kotlinc', 'scala', 'scalac', 'groovy',
    'clojure', 'clj', 'elixir', 'iex', 'erl', 'erlc', 'escript', 'julia', 'dart',
    'ghc', 'ghci', 'runghc', 'runhaskell', 'ocaml', 'ocamlrun', 'ocamlc',
    'fsi', 'fsharpi', 'racket', 'guile', 'gcc', 'g++', 'cc', 'c++', 'clang',
    'clang++', 'gfortran', 'cobc', 'nim', 'crystal', 'zig', 'coffee',
    'awk', 'gawk', 'mawk', 'nawk', 'tclsh', 'wish', 'cscript', 'wscript', 'pwsh', 'powershell',
])

const SHELL_COMMANDS = new Set(['shell', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish'])

export function decideExecPermission(
    args: Record<string, unknown>,
    cwd = process.cwd(),
    platform: NodeJS.Platform = process.platform,
): PermissionDecision {
    const command = args.command
    if (typeof command === 'string') {
        const safePowerShell = platform === 'win32' && isSafeExecCommand(command, platform) &&
            /^(?:powershell|pwsh)(?:\.exe)?\s/i.test(command.trim())
        const language = safePowerShell ? undefined : findScriptExecution(command, cwd)
        if (language) return { kind: 'block', message: LANGUAGE_MESSAGES[language] }
        const dangerousReason = getDangerousCommandReason(command, cwd)
        if (dangerousReason) return { kind: 'block', message: dangerousReason }
    }
    if (typeof command !== 'string' || !isCommandInProjectDir(command, cwd, platform)) {
        return { kind: 'block', message: EXEC_DIRECTORY_MESSAGE }
    }
    return isSafeExecCommand(command, platform) ? { kind: 'allow' } : { kind: 'confirm' }
}

type Token = { word: string } | { operator: string }

/** Inspect command positions, not ordinary arguments mentioning a language. */
function findScriptExecution(command: string, cwd: string, depth = 0): ScriptLanguage | undefined {
    if (depth > 20) return undefined
    const tokens = tokenize(command, true)
    if (!tokens) return undefined
    let words: string[] = []
    let redirectTarget = false

    const inspect = (): ScriptLanguage | undefined => {
        const segment = words
        words = []
        while (segment.length) {
            const executable = segment.shift()!
            if (/^[A-Za-z_]\w*=/.test(executable) || ['!', 'if', 'then', 'elif', 'do'].includes(executable)) continue
            const name = path.basename(executable).replace(/\.exe$/i, '')
            const language = executableLanguage(name)
            if (language) return language

            if (['uv', 'poetry', 'pipenv', 'conda', 'pyenv'].includes(name) &&
                ['run', 'exec'].includes(segment[0])) {
                return findScriptExecution(segment.slice(1).map(shellQuote).join(' '), cwd, depth + 1) ?? 'python'
            }

            if (SHELL_COMMANDS.has(name)) {
                const commandIndex = segment.findIndex((word) => /^-[^-]*c/.test(word) || word === '--command')
                if (commandIndex >= 0) return findScriptExecution(segment[commandIndex + 1] ?? '', cwd, depth + 1)
                const script = segment.find((word) => !word.startsWith('-'))
                if (!script) return undefined
                return executableLanguage(path.basename(script)) ?? findScriptExecution(
                    shellQuote(script.includes('/') ? script : `./${script}`), cwd, depth + 1,
                )
            }
            if (name === 'eval') return findScriptExecution(segment.join(' '), cwd, depth + 1)
            if (name === 'command' && segment.some((word) => word === '-v' || word === '-V')) return undefined
            if (['env', 'command', 'builtin', 'exec', 'nohup', 'nice', 'timeout', 'time',
                'sudo', 'setsid', 'xargs', 'npx'].includes(name) ||
                (['npm', 'pnpm', 'yarn'].includes(name) && ['exec', 'dlx'].includes(segment[0]))) {
                if (['npm', 'pnpm', 'yarn'].includes(name)) segment.shift()
                while (segment.length) {
                    const option = segment[0]
                    if (/^[A-Za-z_]\w*=/.test(option) || /^\d+(?:\.\d+)?[smhd]?$/.test(option)) {
                        segment.shift()
                    } else if (option.startsWith('-')) {
                        segment.shift()
                        if (['-C', '--chdir', '-u', '--unset', '-n', '-s', '--signal',
                            '-k', '--kill-after', '-p', '--package', '-I'].includes(option)) segment.shift()
                        if (option === '-S' || option === '--split-string' || option === '-c') {
                            return findScriptExecution(segment.join(' '), cwd, depth + 1)
                        }
                    } else break
                }
                continue
            }

            // Inspect both the interpreter and local shell script contents.
            if (executable.includes('/') && isInProjectDir(executable, cwd)) {
                let descriptor: number | undefined
                try {
                    descriptor = fs.openSync(path.resolve(cwd, executable), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
                    const stat = fs.fstatSync(descriptor)
                    if (!stat.isFile() || stat.size > 64 * 1024) return undefined
                    const buffer = Buffer.alloc(Math.min(stat.size, 64 * 1024))
                    const count = fs.readSync(descriptor, buffer, 0, buffer.length, 0)
                    const content = buffer.subarray(0, count).toString('utf8')
                    const firstLine = content.split('\n')[0]
                    if (firstLine.startsWith('#!')) {
                        const shebang = firstLine.slice(2)
                        const language = findScriptExecution(shebang, cwd, depth + 1)
                        if (language) return language
                        const interpreter = tokenize(shebang, true)?.flatMap((token) =>
                            'word' in token ? [token.word] : []).find((word) =>
                            path.basename(word) !== 'env' && !word.startsWith('-') && !word.includes('='))
                        return interpreter && SHELL_COMMANDS.has(path.basename(interpreter))
                            ? findScriptExecution(content.slice(firstLine.length + 1), cwd, depth + 1)
                            : 'other'
                    }
                    if (/\.(?:sh|bash|zsh|bat|cmd)$/i.test(executable)) {
                        return findScriptExecution(content, cwd, depth + 1)
                    }
                } catch {
                    // Missing files still follow the existing directory/confirmation policy.
                } finally {
                    if (descriptor !== undefined) fs.closeSync(descriptor)
                }
            }
            return undefined
        }
        return undefined
    }

    for (const token of tokens) {
        if ('word' in token) {
            if (!redirectTarget) words.push(token.word)
            redirectTarget = false
        } else if (token.operator === '<' || token.operator === '>') {
            redirectTarget = true
        } else {
            const language = inspect()
            if (language) return language
            redirectTarget = false
        }
    }
    return inspect()
}

function executableLanguage(name: string): ScriptLanguage | undefined {
    if (/^(?:pythonw?|pypy|ipython)(?:\d+(?:\.\d+)*)?$/.test(name) || /\.(?:py|pyw|pyc|pyo|ipynb)$/i.test(name)) return 'python'
    if (/^(?:node(?:js)?|bun|deno|tsx|ts-node(?:-esm|-script|-transpile-only)?|jsc|qjs|quickjs|d8|js)$/.test(name) ||
        /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/i.test(name)) return 'javascript'
    if (OTHER_LANGUAGE_COMMANDS.has(name) || /^(?:ruby|perl|php|lua|luajit)\d+(?:\.\d+)*$/.test(name) ||
        /\.(?:java|jar|class|cs|csx|fsx|go|rb|rs|pl|php|lua|r|swift|kt|kts|scala|groovy|clj|ex|exs|erl|jl|dart|hs|ml|c|cpp|cc|cxx|fs|nim|cr|zig|coffee)$/i.test(name)) return 'other'
    return undefined
}

/**
 * Check explicit shell paths without executing the command. Dynamic shell syntax
 * is rejected because static inspection cannot establish its working directory.
 * This is a permission precheck, not an OS sandbox for arbitrary program code.
 */
export function isCommandInProjectDir(command: string, cwd = process.cwd(), platform: NodeJS.Platform = process.platform): boolean {
    try {
        const project = fs.realpathSync.native(cwd)
        return checkCommand(command, project, project, platform)
    } catch {
        return false
    }
}

function checkCommand(command: string, project: string, initialDirectory: string, platform: NodeJS.Platform): boolean {
    const tokens = tokenize(command, false, platform)
    if (!tokens || tokens.length === 0) return false
    let directory = initialDirectory
    const stack: string[] = []
    let words: string[] = []

    const checkSegment = (): boolean => {
        if (words.length === 0) return true
        const segment = words
        words = []
        while (segment[0] && /^(?:[A-Za-z_][\w]*=|command$|builtin$|exec$)/.test(segment[0])) {
            const prefix = segment.shift()!
            if (prefix.includes('=') && !checkPath(prefix.slice(prefix.indexOf('=') + 1))) return false
        }
        if (segment[0] === 'env') {
            segment.shift()
            while (segment[0]?.startsWith('-') || segment[0]?.includes('=')) {
                const option = segment.shift()!
                if (option === '-C' || option.startsWith('-C') ||
                    option === '--chdir' || option.startsWith('--chdir=')) {
                    const target = option.includes('=') ? option.slice(option.indexOf('=') + 1)
                        : option.length > 2 && option.startsWith('-C') ? option.slice(2) : segment.shift()
                    const targetDirectory = target && resolveDirectory(target)
                    if (!targetDirectory) return false
                    // env changes only its child process, not subsequent shell commands.
                    return checkCommand(segment.map(shellQuote).join(' '), project,
                        targetDirectory, platform)
                }
                if (option === '-u' || option === '--unset') {
                    if (!segment.shift()) return false
                    continue
                }
                if (option.startsWith('-') && !['-i', '--ignore-environment', '--'].includes(option) &&
                    !option.startsWith('--unset=')) return false
                if (!checkPath(option)) return false
            }
            return checkCommand(segment.map(shellQuote).join(' '), project, directory, platform)
        }
        const executable = segment.shift()
        if (!executable) return true
        const windowsName = executable.toLowerCase().replace(/\.exe$/, '')
        if (platform === 'win32' && ['cmd', 'powershell', 'pwsh'].includes(windowsName)) {
            const index = segment.findIndex((arg) => ['/c', '/k', '-c', '-command'].includes(arg.toLowerCase()))
            return index >= 0 && checkCommand(segment.slice(index + 1).join(' '), project, directory, platform)
        }
        // These commands can evaluate strings or source code containing hidden cd calls.
        if (['eval', 'source', '.', 'xargs'].includes(executable)) return false
        if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(executable)) {
            const commandIndex = segment.findIndex((word) => /^-[^-]*c/.test(word))
            if (commandIndex < 0 || !segment[commandIndex + 1]) return false
            // Keep the original boundary even when the enclosing shell already changed directory.
            return checkCommand(segment[commandIndex + 1], project, directory, platform)
        }
        if (executable === 'cd' || executable === 'pushd') {
            const targets = segment.filter((word) => word !== '--' && word !== '-L' && word !== '-P')
            if (targets.length !== 1 || targets[0] === '-') return false
            const targetDirectory = resolveDirectory(targets[0])
            if (!targetDirectory) return false
            if (executable === 'pushd') return false // Directory stacks are shell-dependent.
            directory = targetDirectory
            return true
        }
        if (executable === 'popd') return false
        return [executable, ...segment].every((word) => checkPath(
            platform === 'win32' && isWindowsReadSwitch(word, executable) ? '.' :
            ['git', 'make', 'tar'].includes(executable) && word.startsWith('-C') && word.length > 2
                ? word.slice(2) : word,
        ))
    }

    const checkPath = (word: string, alwaysPath = false): boolean => {
        const value = !alwaysPath && word.startsWith('-') && word.includes('=')
            ? word.slice(word.indexOf('=') + 1) : word
        if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return !alwaysPath
        if (value.startsWith('~')) return false
        // Inspect each component before normalizing '..', so a symlink followed
        // by '..' cannot hide a traversal outside the project.
        let candidate = path.isAbsolute(value) ? path.parse(value).root : directory
        for (const component of value.split(path.sep).filter(Boolean)) {
            candidate = path.join(candidate, component)
            try {
                candidate = fs.realpathSync.native(candidate)
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
            }
            // Absolute paths pass through ancestors of the project first.
            const relativeProject = path.relative(candidate, project)
            if (path.isAbsolute(value) && relativeProject !== '..' &&
                !relativeProject.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeProject)) continue
            if (!isInProjectDir(candidate, project)) return false
        }
        return isInProjectDir(candidate, project)
    }

    const resolveDirectory = (target: string): string | undefined => {
        if (!checkPath(target, true)) return undefined
        // CDPATH can redirect a bare relative cd target before searching cwd.
        if (process.env.CDPATH && !path.isAbsolute(target) && !target.startsWith('.')) return undefined
        try {
            const resolved = fs.realpathSync.native(path.resolve(directory, target))
            return fs.statSync(resolved).isDirectory() && isInProjectDir(resolved, project)
                ? resolved : undefined
        } catch {
            // A failed cd followed by ';' would leave later commands in the old cwd.
            return undefined
        }
    }

    for (const token of tokens) {
        if ('word' in token) {
            words.push(token.word)
            continue
        }
        if (!checkSegment()) return false
        if (token.operator === '(') stack.push(directory)
        if (token.operator === ')') {
            const previous = stack.pop()
            if (!previous) return false
            directory = previous
        }
    }
    return checkSegment() && stack.length === 0
}

function shellQuote(word: string): string {
    return "'" + word.replace(/'/g, "'\\''") + "'"
}

/** Preserve quoted words; never expand variables, substitutions or globs. */
function tokenize(command: string, inspectLanguages = false, platform: NodeJS.Platform = process.platform): Token[] | undefined {
    const tokens: Token[] = []
    let word = ''
    let started = false
    let quote: "'" | '"' | undefined
    const flush = () => {
        if (started) tokens.push({ word })
        word = ''
        started = false
    }
    for (let index = 0; index < command.length; index++) {
        const char = command[index]
        if (quote === "'") {
            if (char === quote) quote = undefined
            else word += char
            continue
        }
        if (char === '\\' && platform !== 'win32') {
            const next = command[++index]
            if (next === undefined) return undefined
            if (next !== '\n') {
                if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) word += '\\'
                word += next
                started = true
            }
            continue
        }
        if (!inspectLanguages && (char === '$' || char === '`')) return undefined
        if (quote === '"') {
            if (char === quote) quote = undefined
            else word += char
            continue
        }
        if (char === "'" || char === '"') {
            quote = char
            started = true
        } else if (char === '#' && !started) {
            while (index + 1 < command.length && command[index + 1] !== '\n') index++
        } else if (char === '\n' || ';&|()<>'.includes(char) ||
            (inspectLanguages && '{}'.includes(char))) {
            flush()
            // Reject here-documents and process substitution, which contain shell code.
            if (!inspectLanguages && ((char === '<' && command[index + 1] === '<') ||
                ((char === '<' || char === '>') && command[index + 1] === '('))) return undefined
            tokens.push({ operator: char })
        } else if (/\s/.test(char)) {
            flush()
        } else if (!inspectLanguages && '*?[]{}'.includes(char)) {
            return undefined
        } else {
            word += char
            started = true
        }
    }
    if (quote) return undefined
    flush()
    return tokens
}
