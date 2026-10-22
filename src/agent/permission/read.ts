import { isDangerousPath } from './is-dangerous-path'
import { blockPermission, PermissionDecision, PROTECTED_PATH_MESSAGE } from './util'

export function decideReadPermission(
    args: Record<string, unknown>,
    cwd = process.cwd(),
): PermissionDecision {
    const filepath = args.file_path
    if (typeof filepath !== 'string') return { kind: 'allow' }
    if (isDangerousPath(filepath, { cwd })) {
        return blockPermission('protected_path', PROTECTED_PATH_MESSAGE)
    }
    return { kind: 'allow' }
}
