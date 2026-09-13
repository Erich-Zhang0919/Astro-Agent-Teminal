import { webFetchFn } from './web_fetch'

const mockFetch = jest.fn()
global.fetch = mockFetch

beforeEach(() => {
    mockFetch.mockReset()
})

describe('webFetchFn', () => {
    it('returns page content on success', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () => '<html>hello world</html>',
        })

        const result = await webFetchFn({ url: 'https://example.com' })
        expect(result).toBe('<html>hello world</html>')
        expect(mockFetch).toHaveBeenCalledWith(
            'https://example.com',
            expect.objectContaining({ headers: expect.any(Object) }),
        )
    })

    it('returns the full response when it exceeds 50 000 chars', async () => {
        const longContent = 'x'.repeat(60_000)
        mockFetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () => longContent,
        })

        const result = await webFetchFn({ url: 'https://example.com' })
        expect(result).toBe(longContent)
    })

    it('returns error message on HTTP error status', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: false,
            status: 404,
            statusText: 'Not Found',
            text: async () => '',
        })

        const result = await webFetchFn({ url: 'https://example.com/missing' })
        expect(result).toBe('Error: HTTP 404 Not Found')
    })

    it('returns error message when fetch throws (network error)', async () => {
        mockFetch.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND no-such-host.invalid'))

        const result = await webFetchFn({ url: 'https://no-such-host.invalid' })
        expect(result).toMatch(/^Error: fetch failed/)
        expect(result).toContain('ENOTFOUND')
    })

    it('returns error for an invalid URL', async () => {
        const result = await webFetchFn({ url: 'not-a-url' })
        expect(result).toMatch(/^Error: invalid URL/)
        expect(mockFetch).not.toHaveBeenCalled()
    })

    it('returns error for non-http/https protocols', async () => {
        const result = await webFetchFn({ url: 'ftp://example.com/file.txt' })
        expect(result).toMatch(/^Error: only http and https/)
        expect(mockFetch).not.toHaveBeenCalled()
    })
})
