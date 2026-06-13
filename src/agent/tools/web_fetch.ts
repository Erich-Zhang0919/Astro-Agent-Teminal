const MAX_CONTENT_LENGTH = 50_000

export async function webFetchFn({ url }: { url: string }): Promise<string> {
    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        return `Error: invalid URL "${url}"`
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return `Error: only http and https URLs are supported, got "${parsed.protocol}"`
    }

    let response: Response
    try {
        response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; web-fetch-tool/1.0)' },
            signal: AbortSignal.timeout(15_000),
        })
    } catch (err: any) {
        return `Error: fetch failed — ${err.message}`
    }

    if (!response.ok) {
        return `Error: HTTP ${response.status} ${response.statusText}`
    }

    try {
        const text = await response.text()
        console.log(`\n[Tool] web_fetch called: "${url}" (${text.length} chars)`)
        return text.length > MAX_CONTENT_LENGTH ? text.slice(0, MAX_CONTENT_LENGTH) + '\n...(truncated)' : text
    } catch (err: any) {
        return `Error: failed to read response body — ${err.message}`
    }
}
