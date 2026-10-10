import { isSafeDomain } from './is-safe-domains'

describe('safe URL domains', () => {
    it.each([
        'https://github.com',
        'http://github.com/path?query=value#section',
        'https://GITHUB.COM:443/path',
        'https://github.com./path',
        'https://docs.github.com/path',
        'https://docs.python.org/path',
        'https://developer.mozilla.org/path',
        'https://kimi.moonshot.cn/path',
        'https://api.kimi.moonshot.cn/path',
        'https://aws.amazon.com/path',
        'ftp://github.com/path',
        'wss://github.com/path',
    ])('matches a listed hostname or its subdomain: %s', (url) => {
        expect(isSafeDomain(url)).toBe(true)
    })

    it.each([
        'https://untrusted.invalid',
        'https://github.com.untrusted.invalid',
        'https://evilgithub.com',
        'https://github.com@untrusted.invalid',
        'https://untrusted.invalid/path/github.com?url=https://github.com',
        'https://gіthub.com',
        'https://moonshot.cn',
        'https://evil.moonshot.cn',
        'https://amazon.com',
        'http://127.0.0.1',
        'http://[::1]',
        'http://localhost',
        'github.com',
        '//github.com',
        'not-a-url',
        '',
        'file:///tmp/local.txt',
        'data:text/plain,github.com',
        'javascript:github.com',
    ])('does not trust deceptive hostnames or malformed URLs: %s', (url) => {
        expect(isSafeDomain(url)).toBe(false)
    })
})
