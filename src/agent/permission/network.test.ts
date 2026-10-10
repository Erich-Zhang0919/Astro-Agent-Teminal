import { decideNetworkPermission } from './network'
import { permissionLevelOf, withPermissionLevel } from './util'

describe('network permission', () => {
    it.each([{}, { query: 'search words' }, { url: undefined }])('allows calls without a URL: %j', (args) => {
        expect(decideNetworkPermission(args)).toEqual({ kind: 'allow' })
    })

    it.each(['https://github.com/path', 'https://docs.python.org/path'])('allows safe URL domains: %s', (url) => {
        expect(decideNetworkPermission({ url })).toEqual({ kind: 'allow' })
    })

    it.each(['https://untrusted.invalid', 'https://github.com.untrusted.invalid', 'not-a-url', '', null, 123])(
        'requires confirmation for unsafe or invalid URLs: %j', (url) => {
            expect(decideNetworkPermission({ url })).toEqual({ kind: 'confirm' })
        },
    )

    it('recognizes network metadata and gives permission_level priority', () => {
        expect(permissionLevelOf(withPermissionLevel({}, 'network'))).toBe('network')
        expect(permissionLevelOf({ permission_level: 'network' })).toBe('network')
        expect(permissionLevelOf({ permission_tool: 'network' })).toBe('network')
        expect(permissionLevelOf({ permission_level: 'network', permission_tool: 'read' })).toBe('network')
    })
})
