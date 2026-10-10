import * as fs from 'node:fs'
import * as path from 'node:path'
import { isDangerousPath } from './is-dangerous-path'
import { isInProjectDir } from './util'

type Category =
    | 'privilege escalation' | 'file deletion' | 'file modification'
    | 'permission changes' | 'process or service control' | 'user configuration changes'
    | 'sensitive information access' | 'network or remote control' | 'uninspectable execution'

// Apply the union of platform rules, even when reviewing a command on another OS.
const COMMAND_GROUPS: Partial<Record<Category, readonly string[]>> = {
    'privilege escalation': ['sudo', 'sudoedit', 'su', 'doas', 'pkexec', 'runas', 'gsudo', 'elevate', 'chroot', 'nsenter', 'unshare'],
    'file deletion': ['rm', 'rmdir', 'unlink', 'shred', 'del', 'erase', 'rd', 'sdelete', 'remove-item', 'ri', 'clear-recyclebin'],
    'file modification': [
        'mv', 'cp', 'touch', 'mkdir', 'mktemp', 'install', 'truncate', 'tee', 'dd', 'patch', 'ln',
        'mkfs', 'fdisk', 'parted', 'wipefs', 'diskutil', 'diskpart', 'format',
        'copy', 'xcopy', 'robocopy', 'move', 'ren', 'rename', 'md', 'mklink', 'fsutil', 'ditto', 'sips', 'forfiles',
        'new-item', 'ni', 'set-content', 'add-content', 'ac', 'clear-content', 'clc',
        'copy-item', 'cpi', 'move-item', 'mi', 'rename-item', 'rni', 'out-file',
        'export-csv', 'export-clixml', 'set-item', 'set-itemproperty', 'new-itemproperty',
        'remove-itemproperty', 'clear-item', 'clear-itemproperty', 'set-location',
        'vi', 'vim', 'nvim', 'nano', 'emacs', 'ed', 'ex', 'gsettings', 'dconf',
    ],
    'permission changes': ['chmod', 'chown', 'chgrp', 'setfacl', 'setcap', 'chattr', 'chflags', 'xattr', 'icacls', 'cacls', 'takeown', 'attrib', 'set-acl', 'set-executionpolicy', 'secedit', 'auditpol'],
    'process or service control': [
        'kill', 'pkill', 'killall', 'killpg', 'xkill', 'renice', 'systemctl', 'service',
        'init', 'telinit', 'shutdown', 'reboot', 'halt', 'poweroff', 'launchctl', 'launchd',
        'pmset', 'caffeinate', 'taskkill', 'tskill', 'schtasks', 'at', 'crontab',
        'start', 'stop-process', 'spps', 'kill-process', 'start-process', 'saps',
        'start-service', 'stop-service', 'restart-service', 'suspend-service', 'resume-service',
        'set-service', 'new-service', 'remove-service', 'register-scheduledtask', 'unregister-scheduledtask',
        'stop-computer', 'restart-computer', 'rundll32', 'regsvr32', 'docker', 'podman', 'kubectl',
        'open', 'xdg-open', 'invoke-cimmethod', 'invoke-wmimethod', 'set-ciminstance', 'remove-ciminstance',
    ],
    'user configuration changes': [
        'useradd', 'userdel', 'usermod', 'adduser', 'deluser', 'groupadd', 'groupdel', 'groupmod',
        'addgroup', 'delgroup', 'passwd', 'chpasswd', 'chsh', 'chfn', 'gpasswd', 'vipw', 'vigr',
        'dscl', 'sysadminctl', 'dseditgroup', 'chage', 'pw', 'setx',
        'new-localuser', 'set-localuser', 'remove-localuser', 'rename-localuser',
        'enable-localuser', 'disable-localuser', 'new-localgroup', 'set-localgroup', 'remove-localgroup',
        'add-localgroupmember', 'remove-localgroupmember', 'netplwiz',
    ],
    'sensitive information access': [
        'printenv', 'set', 'export', 'unset', 'credential', 'cmdkey', 'vaultcmd',
        'security', 'secret-tool', 'pass', 'gpg', 'gpg2', 'ssh-add', 'ssh-keygen',
        'ssh-keyscan', 'get-credential', 'get-secret', 'get-secretinfo', 'get-childitem-env',
    ],
    'network or remote control': [
        'curl', 'wget', 'fetch', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'lftp', 'tftp', 'telnet',
        'nc', 'ncat', 'netcat', 'socat', 'nmap', 'masscan', 'ping', 'ping6', 'traceroute',
        'tracepath', 'tracert', 'dig', 'nslookup', 'host', 'netstat', 'ss', 'ip', 'ifconfig',
        'ipconfig', 'arp', 'route', 'netsh', 'networksetup', 'scutil', 'iptables', 'ip6tables',
        'nft', 'ufw', 'firewall-cmd', 'pfctl', 'openssl', 'openvpn', 'wg', 'tailscale',
        'mstsc', 'winrs', 'psexec', 'pscp', 'psftp', 'plink', 'bitsadmin', 'certutil', 'certreq',
        'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'wget',
        'invoke-command', 'icm', 'enter-pssession', 'etsn', 'new-pssession',
        'connect-pssession', 'new-psdrive', 'start-bitstransfer', 'test-connection',
        'test-netconnection', 'new-netfirewallrule', 'set-netfirewallrule',
        'enable-netfirewallrule', 'disable-netfirewallrule', 'remove-netfirewallrule',
    ],
}

const COMMAND_CATEGORIES = new Map(Object.entries(COMMAND_GROUPS).flatMap(([category, names]) =>
    names.map((name) => [name, category as Category] as const)))

const EXECUTION_ENVIRONMENT = /^(?:BASH_ENV|ENV|ZDOTDIR|PROMPT_COMMAND|SHELLOPTS|LD_PRELOAD|DYLD_INSERT_LIBRARIES)=/i

type Token = { word: string; dynamic?: boolean } | { operator: string }

const PATH_READ_COMMANDS = new Set([
    'cat', 'type', 'get-content', 'gc', 'head', 'tail', 'more', 'less', 'bat', 'strings',
    'od', 'xxd', 'hexdump', 'base64', 'grep', 'rg', 'find', 'ls', 'dir', 'tree', 'stat',
    'readlink', 'du', 'file', 'sort', 'cut', 'jq', 'yq', 'sed', 'plutil', 'sqlite3',
    'get-item', 'gi', 'get-childitem', 'gci', 'select-string', 'sls', 'findstr', 'date', 'git',
])

function blocked(category: Category, operation: string): string {
    return `Blocked: dangerous operation (${category}: ${operation}) is not permitted through exec.`
}

/** Static precheck shared by the approval graph and the actual exec tool. */
export function getDangerousCommandReason(command: string, cwd = process.cwd(), depth = 0): string | undefined {
    if (depth > 20) return blocked('uninspectable execution', 'nested command limit')
    const tokens = tokenizeCommand(command)
    if (!tokens) return blocked('uninspectable execution', 'unmatched quotes or escapes')
    let words: string[] = []
    let readRedirect = false
    let workingDirectory = cwd
    const directoryStack: string[] = []
    const inspect = () => {
        const segment = words
        words = []
        const reason = inspectCommand([...segment], workingDirectory, depth)
        if (reason) return reason
        while (segment[0] && (/^[A-Za-z_]\w*=/.test(segment[0]) || ['command', 'builtin'].includes(segment[0]))) segment.shift()
        if (segment[0] === 'cd' || segment[0] === 'chdir') {
            const target = segment.slice(1).find((word) => !['--', '-L', '-P', '/d', '/D'].includes(word))
            if (target) {
                try { workingDirectory = fs.realpathSync.native(path.resolve(workingDirectory, target)) } catch {
                    return blocked('uninspectable execution', 'unresolvable directory change')
                }
            }
        }
        return undefined
    }
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index]
        if ('word' in token) {
            if (token.dynamic) return blocked('uninspectable execution', 'shell expansion or substitution')
            if (readRedirect) {
                readRedirect = false
                if (sensitivePath(token.word, workingDirectory)) return blocked('sensitive information access', 'input redirection')
            } else words.push(token.word)
        } else if (['>', '>>', '>|', '&>', '&>>', '<>'].includes(token.operator)) {
            return blocked('file modification', 'output redirection')
        } else if (token.operator === '>&' || token.operator === '<&') {
            const target = tokens[++index]
            if (!target || !('word' in target) || !/^(?:\d+|-)$/.test(target.word)) {
                return blocked('file modification', 'descriptor redirection to a file')
            }
        } else if (token.operator === '<') {
            readRedirect = true
        } else if (token.operator === '<<' || token.operator === '<<<') {
            // Here-documents/strings can supply executable code to a shell.
            return blocked('uninspectable execution', 'here-document or here-string')
        } else {
            const reason = inspect()
            if (reason) return reason
            if (token.operator === '(') directoryStack.push(workingDirectory)
            if (token.operator === ')') workingDirectory = directoryStack.pop() ?? workingDirectory
            readRedirect = false
        }
    }
    return inspect()
}

function inspectCommand(words: string[], cwd: string, depth: number): string | undefined {
    while (words.length) {
        let executable = words.shift()!
        if (EXECUTION_ENVIRONMENT.test(executable)) return blocked('uninspectable execution', 'shell startup or preload environment')
        if (executable.toLowerCase() === 'if') {
            while (['/i', 'not'].includes(words[0]?.toLowerCase())) words.shift()
            if (['exist', 'defined', 'errorlevel', 'cmdextversion'].includes(words[0]?.toLowerCase())) words.splice(0, 2)
            else if (words[0]?.includes('==')) words.shift()
            else if (['equ', 'neq', 'lss', 'leq', 'gtr', 'geq'].includes(words[1]?.toLowerCase())) words.splice(0, 3)
            continue
        }
        if (/^[A-Za-z_]\w*=/.test(executable) || ['!', 'then', 'elif', 'do', '@'].includes(executable)) continue
        const compactCmd = /^(cmd(?:\.exe)?)(\/[ck])$/i.exec(executable)
        if (compactCmd) { executable = compactCmd[1]; words.unshift(compactCmd[2]) }
        const name = commandName(executable)
        const args = words.map((word) => word.toLowerCase())
        if (['start-process', 'saps'].includes(name) && args.includes('runas')) return blocked('privilege escalation', name)
        const category = COMMAND_CATEGORIES.get(name)
        if (category) return blocked(category, name)
        if (/^(?:mkfs|mount)\./.test(name) || ['mount', 'umount'].includes(name)) return blocked('file modification', name)
        if (name === 'sc.exe' || name === 'sc') return blocked('process or service control', name)

        if (['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'shell', 'cmd', '%comspec%'].includes(name)) {
            for (const flag of ['--rcfile', '--init-file']) {
                const startup = args.indexOf(flag)
                if (startup >= 0) {
                    const reason = inspectScript(words[startup + 1] ?? '', cwd, depth)
                    if (reason) return reason
                }
            }
            const index = args.findIndex((word) => /^-[^-]*c/.test(word) || ['/c', '/k', '--command'].includes(word))
            if (index >= 0) {
                const inner = name === 'cmd' || name === '%comspec%'
                    ? words.slice(index + 1).join(' ') : words[index + 1] ?? ''
                return getDangerousCommandReason(inner, cwd, depth + 1)
            }
            const script = words.find((word) => !word.startsWith('-') && word !== '/d' && word !== '/s')
            return script ? inspectScript(script, cwd, depth) : blocked('uninspectable execution', 'interactive shell')
        }
        if (name === 'powershell' || name === 'pwsh') {
            if (args.some((word) => /^-(?:e|enc|encodedcommand|encodedarguments|ec)$/i.test(word))) {
                return blocked('uninspectable execution', 'encoded PowerShell command')
            }
            const index = args.findIndex((word) => ['-c', '-command', '-commandwithargs'].includes(word))
            if (index >= 0) return getDangerousCommandReason(words.slice(index + 1).join(' '), cwd, depth + 1)
            const fileIndex = args.findIndex((word) => word === '-file' || word === '-f')
            return fileIndex >= 0 && words[fileIndex + 1] ? inspectScript(words[fileIndex + 1], cwd, depth)
                : blocked('uninspectable execution', 'PowerShell input')
        }
        if (['eval', 'source', '.', 'invoke-expression', 'iex', 'osascript', 'mshta', 'wmic', 'wmi',
            'enable', 'alias', 'unalias', 'trap'].includes(name)) {
            return blocked('uninspectable execution', name)
        }
        if (name === 'command' && args.includes('-v')) return undefined
        if (['command', 'builtin', 'exec', 'env', 'nohup', 'nice', 'timeout', 'time', 'setsid', 'xargs', 'call', 'busybox', 'toybox'].includes(name)) {
            while (words.length && (/^[A-Za-z_]\w*=/.test(words[0]) || words[0].startsWith('-') || /^\d+(?:\.\d+)?[smhd]?$/.test(words[0]))) {
                const rawOption = words.shift()!
                if (EXECUTION_ENVIRONMENT.test(rawOption)) return blocked('uninspectable execution', 'shell startup or preload environment')
                const option = rawOption.toLowerCase()
                if ((rawOption === '-S' && name === 'env') || option === '--split-string') {
                    return getDangerousCommandReason(words.join(' '), cwd, depth + 1)
                }
                if (['-u', '--unset', '-c', '--chdir', '-n', '-s', '--signal', '-k', '--kill-after', '-i'].includes(option)) words.shift()
            }
            if (name === 'env' && words.length === 0) return blocked('sensitive information access', 'environment variables')
            continue
        }

        const conditional = conditionalRisk(name, args, words)
        if (conditional) return blocked(conditional, name)
        if (PATH_READ_COMMANDS.has(name) && words.some((word) => sensitivePath(word, cwd))) return blocked('sensitive information access', 'protected path or secret')
        if (/\.(?:sh|bash|zsh|bat|cmd|ps1)$/i.test(executable) || executable.includes('/') || executable.includes('\\')) {
            const reason = inspectScript(executable, cwd, depth, true)
            if (reason) return reason
        }
        return undefined
    }
    return undefined
}

function conditionalRisk(name: string, args: string[], rawArgs: string[]): Category | undefined {
    if (name === 'date') {
        const parseOnly = args.some((arg) => ['-d', '--date', '-r', '--reference', '-j'].includes(arg) ||
            /^--(?:date|reference)=/.test(arg))
        if (args.some((arg) => arg === '-s' || arg.startsWith('--set')) ||
            (!parseOnly && args.some((arg) => /^\d{4,}(?:\.\d+)?$/.test(arg) || /^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/.test(arg))) ||
            (args.includes('-f') && !args.includes('-j'))) return 'user configuration changes'
    }
    if (name === 'sed' && args.some((arg) => /^-[^-]*i/.test(arg) || arg.startsWith('--in-place') ||
        /(?:^|[; /])w\s+\S/.test(arg))) return 'file modification'
    if (name === 'sed' && args.some((arg) => arg === '-f' || arg.startsWith('--file') || /(?:^|[; /])e(?:\s|$)/.test(arg))) return 'uninspectable execution'
    if (name === 'rg' && args.some((arg) => /^--(?:pre|hostname-bin)(?:=|$)/.test(arg))) return 'uninspectable execution'
    if (name === 'plutil' && args.some((arg) => ['-replace', '-insert', '-remove', '-convert', '-o'].includes(arg))) return 'file modification'
    if (args.some((arg) => ['-computername', '-cn', '-cimsession', '-connectionuri'].includes(arg))) return 'network or remote control'
    if (['tar', 'unzip', '7z', '7za', 'bsdtar', 'zip', 'gzip', 'gunzip', 'bzip2', 'bunzip2', 'xz', 'unxz'].includes(name)) {
        if (name === 'tar' || name === 'bsdtar') {
            if (args.some((arg) => /^--(?:extract|create|append|update|delete|concatenate)/.test(arg) || /^-?[a-z]*[xcraud][a-z]*$/.test(arg))) return 'file modification'
        } else if (name === 'unzip') {
            if (!args.includes('-l') && !args.includes('-z')) return 'file modification'
        } else if (['7z', '7za'].includes(name)) {
            if (args.some((arg) => ['a', 'd', 'e', 'x', 'u'].includes(arg))) return 'file modification'
        } else return 'file modification'
    }
    if (name === 'git') {
        if (args.some((arg) => arg === '--output' || arg.startsWith('--output='))) return 'file modification'
        if (args.includes('--ext-diff')) return 'uninspectable execution'
        if (rawArgs.some((arg) => arg === '-c' || arg.startsWith('--config-env'))) return 'sensitive information access'
        let subcommand: string | undefined
        for (let index = 0; index < rawArgs.length; index++) {
            const arg = rawArgs[index]
            if (['-C', '--git-dir', '--work-tree', '--namespace'].includes(arg)) index++
            else if (!arg.startsWith('-')) { subcommand = arg.toLowerCase(); break }
        }
        if (['clone', 'fetch', 'pull', 'push', 'ls-remote', 'submodule'].includes(subcommand ?? '')) return 'network or remote control'
        if (['credential', 'credential-manager', 'credential-osxkeychain', 'config'].includes(subcommand ?? '')) return 'sensitive information access'
        if (subcommand && !['status', 'diff', 'log', 'show', 'ls-files', 'ls-tree', 'rev-parse',
            'rev-list', 'cat-file', 'show-ref', 'describe', 'help', 'version', 'blame', 'grep'].includes(subcommand)) return 'file modification'
    }
    if (['npm', 'pnpm', 'yarn', 'pip', 'pip3', 'brew', 'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'winget', 'choco', 'gem'].includes(name)) {
        if (args.some((arg) => ['install', 'i', 'add', 'ci', 'update', 'upgrade', 'remove', 'uninstall', 'publish', 'login', 'logout', 'exec', 'dlx'].includes(arg))) return 'network or remote control'
    }
    if (['npx', 'aws', 'az', 'gcloud', 'gh', 'glab'].includes(name)) return 'network or remote control'
    if (name === 'net' || name === 'net1') {
        if (args.some((arg) => ['user', 'localgroup', 'group', 'accounts'].includes(arg))) return 'user configuration changes'
        if (args.some((arg) => ['start', 'stop', 'pause', 'continue'].includes(arg))) return 'process or service control'
        return 'network or remote control'
    }
    if (name === 'reg') return args[0] === 'query' ? 'sensitive information access' : 'user configuration changes'
    if (name === 'defaults') return args.includes('read') ? 'sensitive information access' : 'user configuration changes'
    if (name === 'find' && args.some((arg) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'].includes(arg))) return 'file modification'
    if (name === 'sort' && args.some((arg) => /^-o/.test(arg) || arg.startsWith('--output'))) return 'file modification'
    if (name === 'ps' && args.some((arg) => /^[a-z]*e[a-z]*$/.test(arg) || arg === '--environment')) return 'sensitive information access'
    if (['get-childitem', 'gci', 'dir', 'get-item', 'gi', 'get-content', 'gc', 'type', 'cat'].includes(name) && args.some((arg) => arg.startsWith('env:'))) return 'sensitive information access'
    return undefined
}

function sensitivePath(word: string, cwd: string, depth = 0): boolean {
    if (depth > 10) return true
    const value = word.replace(/\\/g, '/').replace(/^--?[^=]+=/, '').toLowerCase()
    if (/(?:^|[/:])(?:\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.env(?:\.[^/]*)?)(?:\/|$)/.test(value) ||
        /(?:^|\/)(?:id_rsa|id_ed25519|shadow|sudoers|credentials|keychains|keyrings)(?:\/|$)/.test(value) ||
        /(?:^|\/)system32\/config\/(?:sam|security|system)(?:\/|$)/.test(value) ||
        /^\/(?:proc|sys|root)(?:\/|$)/.test(value) ||
        /(?:%appdata%|%localappdata%|\/appdata\/|\/user data\/|\/chrome\/|\/firefox\/)/.test(value) ||
        /^(?:env:|\$env:)|%?(?:aws_secret_access_key|github_token|api_key|password|secret_access_key)%?/i.test(word) ||
        /^(?:\\\\|\/\/)[^/\\]/.test(word)) return true
    if (word.startsWith('-') || /^[a-z][a-z\d+.-]*:\/\//i.test(word) || /^[A-Za-z]:/.test(word)) return false
    try {
        const candidate = path.resolve(cwd, word)
        if (fs.lstatSync(candidate).isSymbolicLink()) {
            const target = path.resolve(path.dirname(candidate), fs.readlinkSync(candidate))
            if (sensitivePath(target, cwd, depth + 1)) return true
        }
        const resolved = fs.realpathSync.native(candidate)
        if (resolved !== candidate && sensitivePath(resolved, cwd, depth + 1)) return true
    } catch {
        // Non-path arguments and missing files still use lexical protected-path rules.
    }
    return isDangerousPath(word, { cwd })
}

function inspectScript(filepath: string, cwd: string, depth: number, optional = false): string | undefined {
    const declaredScript = /\.(?:sh|bash|zsh|bat|cmd|ps1)$/i.test(filepath)
    if (!isInProjectDir(filepath, cwd)) return optional && !declaredScript ? undefined : blocked('uninspectable execution', 'external shell script')
    try {
        const resolved = path.resolve(cwd, filepath)
        const stat = fs.statSync(resolved)
        if (!stat.isFile() || stat.size > 64 * 1024) return optional && !declaredScript ? undefined : blocked('uninspectable execution', 'shell script size or type')
        const content = fs.readFileSync(resolved, 'utf8')
        if (optional && !/^#!/.test(content) && !/\.(?:sh|bash|zsh|bat|cmd|ps1)$/i.test(filepath)) return undefined
        return getDangerousCommandReason(content.replace(/^#![^\n]*(?:\n|$)/, ''), cwd, depth + 1)
    } catch {
        return optional ? undefined : blocked('uninspectable execution', 'unreadable shell script')
    }
}

function commandName(word: string): string {
    const normalized = word.replace(/^@/, '').replace(/\\/g, '/')
    const compactBuiltin = /^(del|erase|rd|rmdir|copy|move|ren|rename)(?=\/)/i.exec(normalized)
    return (compactBuiltin?.[1] ?? normalized.split('/').pop()!).replace(/\.(?:exe|com)$/i, '').toLowerCase()
}

/** Recognize POSIX quoting and CMD caret escapes while preserving Windows paths. */
export function tokenizeCommand(command: string): Token[] | undefined {
    const tokens: Token[] = []
    let word = ''
    let started = false
    let dynamic = false
    let quote: string | undefined
    const flush = () => {
        if (started) tokens.push({ word, dynamic })
        word = ''
        started = false
        dynamic = false
    }
    for (let index = 0; index < command.length; index++) {
        const char = command[index]
        if (quote) {
            if (char === quote) quote = undefined
            else if (char === '\\' && quote === '"' && command[index + 1] === '"') word += command[++index]
            else {
                if (quote === '"' && (char === '`' || char === '$' || char === '%' && /%[^%]+%/.test(command.slice(index)) ||
                    char === '!' && /^![^!\s]+!/.test(command.slice(index)))) dynamic = true
                word += char
            }
            continue
        }
        if (char === "'" || char === '"') {
            quote = char
            started = true
        } else if (char === '^' || (char === '\\' && !/^[A-Za-z]:/.test(word) && !word.startsWith('\\') &&
            command[index + 1] !== '\\')) {
            if (++index >= command.length) return undefined
            word += command[index]
            started = true
        } else if (char === '#' && !started) {
            while (index + 1 < command.length && command[index + 1] !== '\n') index++
        } else if (char === '\n' || ';&|(){}<>'.includes(char)) {
            flush()
            const operator = ['&>>', '<<<', '>>', '<<', '>&', '<&', '<>', '>|', '&>', '&&', '||']
                .find((item) => command.startsWith(item, index)) ?? char
            tokens.push({ operator })
            index += operator.length - 1
        } else if (/\s/.test(char)) {
            flush()
        } else {
            if (char === '`' || char === '$' || char === '%' && /%[^%]+%/.test(command.slice(index)) ||
                char === '!' && /^![^!\s]+!/.test(command.slice(index))) dynamic = true
            started = true
            word += char
        }
    }
    if (quote) return undefined
    flush()
    return tokens
}
