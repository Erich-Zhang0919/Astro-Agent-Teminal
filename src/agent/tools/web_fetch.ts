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
        return await response.text()
    } catch (err: any) {
        return `Error: failed to read response body — ${err.message}`
    }
}
