import { tokenizeCommand } from './dangerous-command'

const READ_COMMANDS = new Set(['ls', 'pwd', 'cat', 'head', 'tail', 'grep', 'find', 'echo', 'whoami'])
const WINDOWS_READ_COMMANDS = new Set([
    'dir', 'type', 'findstr', 'get-childitem', 'gci', 'get-location', 'gl',
    'get-content', 'gc', 'select-string', 'sls', 'write-output', 'get-date',
])

/** Only complete commands whose every executable is allowlisted can skip approval. */
export function isSafeExecCommand(command: string, platform: NodeJS.Platform = process.platform, depth = 0): boolean {
    if (depth > 20) return false
    const tokens = tokenizeCommand(command)
    if (!tokens || tokens.length === 0) return false
    let words: string[] = []
    for (const token of tokens) {
        if ('word' in token) {
            if (token.dynamic) return false
            words.push(token.word)
        } else {
            if (![';', '\n', '&&', '||', '|'].includes(token.operator) || !safeSegment(words, platform, depth)) return false
            words = []
        }
    }
    const last = tokens[tokens.length - 1]
    return words.length > 0 ? safeSegment(words, platform, depth)
        : 'operator' in last && [';', '\n'].includes(last.operator)
}

function safeSegment(words: string[], platform: NodeJS.Platform, depth: number): boolean {
    if (depth > 20) return false
    const executable = words[0]
    if (!executable || executable.includes('/') || executable.includes('\\')) return false
    // Never match local scripts by basename, and preserve POSIX case sensitivity.
    const name = platform === 'win32' ? executable.toLowerCase().replace(/\.exe$/, '') : executable
    const args = words.slice(1)
    if (name === 'command' || name === 'builtin') {
        return safeSegment(args[0] === '--' ? args.slice(1) : args, platform, depth + 1)
    }
    if (name === 'git') {
        const remaining = [...args]
        while (remaining[0]?.startsWith('-')) {
            const option = remaining.shift()!
            if (option === '-C') {
                if (!remaining.shift()) return false
            } else if (option !== '--no-pager') return false
        }
        const subcommand = remaining.shift()
        return ['status', 'diff', 'log'].includes(subcommand ?? '') && !remaining.some((arg) =>
            /^(?:--(?:ext-diff|textconv|output|exec-path|paginate|config-env))(?:=|$)/.test(arg),
        )
    }
    if (name === 'date') {
        if (platform === 'win32') return args.length === 1 && args[0].toLowerCase() === '/t'
        for (let index = 0; index < args.length; index++) {
            const arg = args[index]
            if (arg.startsWith('+') || ['-u', '--utc', '--universal', '-R', '--rfc-email', '-j'].includes(arg) ||
                /^-I(?:date|hours|minutes|seconds|ns)?$/.test(arg) ||
                /^--(?:iso-8601|rfc-3339)(?:=\w+)?$/.test(arg)) continue
            if (['-r', '--reference', '-d', '--date'].includes(arg)) {
                if (!args[++index]) return false
            } else if (/^--(?:reference|date)=.+$/.test(arg)) continue
            else return false
        }
        return true
    }
    if (platform === 'win32' && name === 'cmd') {
        // /d prevents AutoRun registry commands from running before the safe command.
        const commandIndex = args.findIndex((arg) => arg.toLowerCase() === '/c')
        const options = args.slice(0, commandIndex).map((arg) => arg.toLowerCase())
        return commandIndex >= 0 && options.includes('/d') && options.every((arg) => ['/d', '/s'].includes(arg)) &&
            isSafeExecCommand(args.slice(commandIndex + 1).join(' '), platform, depth + 1)
    }
    if (platform === 'win32' && (name === 'powershell' || name === 'pwsh')) {
        const commandIndex = args.findIndex((arg) => ['-command', '-c'].includes(arg.toLowerCase()))
        const options = args.slice(0, commandIndex).map((arg) => arg.toLowerCase())
        return commandIndex >= 0 && options.includes('-noprofile') && options.includes('-noninteractive') &&
            options.every((arg) => ['-noprofile', '-noninteractive', '-nologo'].includes(arg)) &&
            isSafeExecCommand(args.slice(commandIndex + 1).join(' '), platform, depth + 1)
    }
    if (name === 'find' && args.some((arg) =>
        ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'].includes(arg.toLowerCase()))) return false
    return READ_COMMANDS.has(name) || (platform === 'win32' && WINDOWS_READ_COMMANDS.has(name))
}

/** Recognized CMD switches are options, rather than POSIX absolute file paths. */
export function isWindowsReadSwitch(word: string, executable: string): boolean {
    const name = executable.toLowerCase().replace(/\.exe$/, '')
    const switches: Record<string, RegExp> = {
        dir: /^\/(?:[abdswplqrx4]+|[ato](?::[a-z-]+)?)$/i,
        find: /^\/[vcni]$/i,
        findstr: /^\/[belerxsmoinpvcl]+$/i,
        date: /^\/t$/i,
        whoami: /^\/(?:user|groups|priv|all|logonid|fqdn|upn|nh|fo)$/i,
    }
    return switches[name]?.test(word) ?? false
}
