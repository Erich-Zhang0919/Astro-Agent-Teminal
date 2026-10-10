import { isSafeDomain } from './is-safe-domains'
import { PermissionDecision } from './util'

export function decideNetworkPermission(args: Record<string, unknown>): PermissionDecision {
    const url = args.url
    if (url === undefined) return { kind: 'allow' }
    return typeof url === 'string' && isSafeDomain(url)
        ? { kind: 'allow' }
        : { kind: 'confirm' }
}
