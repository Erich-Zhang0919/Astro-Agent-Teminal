import { isDangerousPath } from './is-dangerous-path'
import { isInProjectDir, PermissionDecision, PROTECTED_PATH_MESSAGE } from './util'

export function decideWritePermission(
    args: Record<string, unknown>,
    cwd = process.cwd(),
): PermissionDecision {
    const filepath = args.file_path
    if (typeof filepath !== 'string') return { kind: 'allow' }
    if (isDangerousPath(filepath, { cwd })) {
        return { kind: 'block', message: PROTECTED_PATH_MESSAGE }
    }
    return isInProjectDir(filepath, cwd) ? { kind: 'allow' } : { kind: 'confirm' }
}
