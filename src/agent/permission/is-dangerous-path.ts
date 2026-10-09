import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import dangerousPaths from './dangerous-path.json'

export type DangerousPathPlatform = 'macos' | 'linux' | 'windows'

export interface DangerousPathOptions {
    platform?: DangerousPathPlatform
    cwd?: string
    homeDir?: string
    env?: NodeJS.ProcessEnv
}

/**
 * Check a path against dangerous-path.json. Relative paths use cwd; ~ and
 * environment variables are expanded before matching. Unresolvable paths or
 * variables are treated as dangerous so callers cannot accidentally allow them.
 */
export function isDangerousPath(
    filepath: string,
    options: DangerousPathOptions = {},
): boolean {
    if (typeof filepath !== 'string' || !filepath || filepath.includes('\0')) return true

    const platform = options.platform ?? currentPlatform()
    if (!platform) return true

    const paths = platform === 'windows' ? path.win32 : path.posix
    const homeDir = options.homeDir ?? os.homedir()
    const cwd = options.cwd ?? (isNativePlatform(platform) ? process.cwd() : homeDir)
    const env = options.env ?? process.env

    try {
        if (!paths.isAbsolute(homeDir) || !paths.isAbsolute(cwd)) return true

        const expand = (value: string): string => {
            let expanded = unquote(value)
            const startsWithVariable = platform === 'windows'
                ? /^%[^%]+%/u.test(expanded)
                : /^\$(?:\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*)/u.test(expanded)
            if (expanded === '~' || /^~[\\/]/u.test(expanded)) {
                expanded = homeDir + expanded.slice(1)
            } else if (expanded.startsWith('~')) {
                throw new Error('Cannot resolve another user\'s home directory.')
            }

            for (let depth = 0; depth < 10; depth += 1) {
                const previous = expanded
                if (platform === 'windows') {
                    expanded = expanded.replace(/%([^%]+)%/gu, (_match, key: string) => {
                        const value = lookupWindowsVariable(key, env, homeDir)
                        if (!value) throw new Error(`Unknown environment variable: ${key}`)
                        return value
                    })
                } else {
                    expanded = expanded.replace(/\$(?:\{([^}]+)\}|([A-Za-z_][A-Za-z0-9_]*))/gu,
                        (_match, braced: string | undefined, plain: string | undefined) => {
                            const key = braced ?? plain ?? ''
                            const value = key === 'HOME' ? homeDir : env[key]
                            if (!value) throw new Error(`Unknown environment variable: ${key}`)
                            return value
                        })
                }
                if (expanded === previous) {
                    if (platform === 'windows' ? /%[^%]+%/u.test(expanded)
                        : /\$(?:\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*)/u.test(expanded)) {
                        throw new Error('Environment variable expansion is recursive.')
                    }
                    if (startsWithVariable && !paths.isAbsolute(expanded)) {
                        throw new Error('Path variable resolved to a relative path.')
                    }
                    return expanded
                }
            }
            throw new Error('Environment variable expansion did not settle.')
        }

        const candidate = resolvedForms(expand(filepath), cwd, paths, platform)
        for (const rule of dangerousPaths[platform]) {
            const forms = resolvedForms(expand(rule), cwd, paths, platform)
            if (candidate.some((item) => forms.some((pattern) => matchesRule(item, pattern)))) {
                return true
            }
        }
        return false
    } catch {
        return true
    }
}

function currentPlatform(): DangerousPathPlatform | undefined {
    if (process.platform === 'darwin') return 'macos'
    if (process.platform === 'win32') return 'windows'
    if (process.platform === 'linux') return 'linux'
    return undefined
}

function isNativePlatform(platform: DangerousPathPlatform): boolean {
    return (platform === 'macos' && process.platform === 'darwin') ||
        (platform === 'windows' && process.platform === 'win32') ||
        (platform === 'linux' && process.platform === 'linux')
}

function unquote(value: string): string {
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1)
    }
    if (value.startsWith('"') || value.startsWith("'")) {
        throw new Error('Unmatched quote in path.')
    }
    return value
}

function lookupWindowsVariable(
    name: string,
    env: NodeJS.ProcessEnv,
    homeDir: string,
): string | undefined {
    const key = name.toUpperCase()
    const supplied = Object.entries(env).find(([entry]) => entry.toUpperCase() === key)?.[1]
    if (supplied) return supplied
    if (key === 'USERPROFILE') return homeDir
    if (key === 'APPDATA') return path.win32.join(homeDir, 'AppData', 'Roaming')
    if (key === 'LOCALAPPDATA') return path.win32.join(homeDir, 'AppData', 'Local')
    return undefined
}

function resolvedForms(
    expanded: string,
    cwd: string,
    paths: typeof path.posix,
    platform: DangerousPathPlatform,
): string[] {
    if (platform === 'windows') {
        expanded = normalizeWindowsInput(expanded, cwd)
    }
    if (platform === 'windows' && /^[A-Za-z]:(?:$|[^\\/])/u.test(expanded)) {
        throw new Error('Drive-relative paths depend on hidden per-drive working directories.')
    }

    const absolute = paths.isAbsolute(expanded)
        ? expanded
        : `${cwd}${paths.sep}${expanded}`
    const lexical = paths.resolve(absolute)
    const forms = [comparisonForm(lexical, platform)]

    if (isNativePlatform(platform)) {
        const canonical = realpathWithMissingSuffix(absolute, paths)
        forms.push(comparisonForm(canonical, platform))
    }
    return forms
}

function normalizeWindowsInput(value: string, cwd: string): string {
    value = value.replace(/\//gu, '\\')
    if (value.startsWith('\\\\.\\')) {
        throw new Error('Windows device paths cannot be classified safely.')
    }
    if (value.toLowerCase().startsWith('\\\\?\\unc\\')) {
        value = `\\\\${value.slice(8)}`
    } else if (value.startsWith('\\\\?\\')) {
        const localPath = value.slice(4)
        if (!/^[A-Za-z]:[\\/]/u.test(localPath)) {
            throw new Error('Unsupported Windows namespaced path.')
        }
        value = localPath
    }
    if (/^[\\/](?![\\/])/u.test(value)) {
        const root = path.win32.parse(cwd).root
        if (!/^[A-Za-z]:[\\/]/u.test(root)) {
            throw new Error('Cannot resolve drive-rooted path without a drive.')
        }
        value = `${root.slice(0, 2)}${value}`
    }
    if (value.split('\\').some((segment) => segment !== '.' && segment !== '..' && /[. ]$/u.test(segment))) {
        throw new Error('Windows may ignore trailing dots and spaces in path segments.')
    }
    if (value.slice(/^[A-Za-z]:/u.test(value) ? 2 : 0).includes(':')) {
        throw new Error('Windows alternate data streams cannot be classified safely.')
    }
    return value
}

function realpathWithMissingSuffix(value: string, paths: typeof path.posix): string {
    let ancestor = value
    const missing: string[] = []

    while (true) {
        try {
            return paths.resolve(fs.realpathSync.native(ancestor), ...missing)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            const parent = paths.dirname(ancestor)
            if (parent === ancestor) throw error
            missing.unshift(paths.basename(ancestor))
            ancestor = parent
        }
    }
}

function comparisonForm(value: string, platform: DangerousPathPlatform): string {
    const slashSeparated = value.replace(/\\/gu, '/')
    return platform === 'linux' ? slashSeparated : slashSeparated.toLowerCase()
}

function matchesRule(candidate: string, rule: string): boolean {
    const escaped = rule.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&')
        .replace(/\*/gu, '[^/]*')
    return new RegExp(`^${escaped}(?:/|$)`, 'u').test(candidate)
}
