if (typeof globalThis.crypto === 'undefined') {
    const { webcrypto } = require('node:crypto')
    Object.defineProperty(globalThis, 'crypto', {
        value: webcrypto,
        writable: false,
        configurable: true,
        enumerable: false,
    })
}
