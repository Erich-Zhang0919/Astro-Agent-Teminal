export async function searchFn({ query }: { query: string }): Promise<string> {
    if (
        query.toLowerCase().includes('sf') ||
        query.toLowerCase().includes('san francisco')
    ) {
        return "It's 60 degrees and foggy."
    }
    return "It's 90 degrees and sunny."
}
