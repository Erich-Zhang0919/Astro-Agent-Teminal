import * as fs from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'

export type PermissionLevel = 'read' | 'write' | 'exec' | 'network' | 'mcp'

export interface ToolBlockReason {
    source: 'permission' | 'hook' | 'user'
    code: 'outside_workspace' | 'script_language' | 'dangerous_command' | 'protected_path'
        | 'tool_unavailable' | 'hook_blocked' | 'user_rejected' | 'policy_blocked'
    message: string
}

export type PermissionDecision =
    | { kind: 'allow' }
    | { kind: 'confirm' }
    | { kind: 'block'; message: string; reason?: ToolBlockReason }

export function blockPermission(code: ToolBlockReason['code'], message: string): PermissionDecision {
    return { kind: 'block', message, reason: { source: 'permission', code, message } }
}

export const PROTECTED_PATH_MESSAGE =
    'Access to this protected path is blocked. Please choose a safe path instead.'

export function withPermissionLevel<T extends object, L extends PermissionLevel>(
    tool: T,
    permission_level: L,
): T & { permission_level: L; permission_tool: L } {
    return Object.assign(tool, { permission_level, permission_tool: permission_level })
}

export function permissionLevelOf(tool: unknown): PermissionLevel | undefined {
    if (!tool || typeof tool !== 'object') return undefined
    const metadata = tool as Partial<Record<'permission_level' | 'permission_tool', unknown>>
    for (const field of ['permission_level', 'permission_tool'] as const) {
        const level = metadata[field]
        if (level === 'read' || level === 'write' || level === 'exec' || level === 'network' || level === 'mcp') return level
    }
    return undefined
}

export function isInProjectDir(filepath: string, cwd = process.cwd()): boolean {
    const project = path.resolve(cwd)
    const candidate = path.resolve(project, filepath)
    const astro = path.join(homedir(), '.astro')

    return [project, astro].some(root => {
        if (!isWithin(root, candidate)) return false
        try {
            // The user-level .astro directory may not have been created yet.
            const realRoot = root === project
                ? fs.realpathSync.native(root)
                : realpathWithMissingSuffix(root)
            return isWithin(realRoot, realpathWithMissingSuffix(candidate))
        } catch {
            return false
        }
    })
}

function isWithin(parent: string, candidate: string): boolean {
    const relative = path.relative(parent, candidate)
    return relative === '' || (relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function realpathWithMissingSuffix(candidate: string): string {
    let ancestor = candidate
    const missing: string[] = []
    while (true) {
        try {
            return path.resolve(fs.realpathSync.native(ancestor), ...missing)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            const parent = path.dirname(ancestor)
            if (parent === ancestor) throw error
            missing.unshift(path.basename(ancestor))
            ancestor = parent
        }
    }
}
