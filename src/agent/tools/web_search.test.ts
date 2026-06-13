import { webSearchTool } from './web_search'

jest.mock('@langchain/tavily', () => {
    return {
        TavilySearch: jest.fn().mockImplementation(() => ({
            invoke: jest.fn().mockResolvedValue(
                JSON.stringify([
                    { title: 'Mock result', url: 'https://example.com', content: 'Mock content' },
                ]),
            ),
            name: 'tavily_search',
            description: 'A search engine.',
        })),
    }
})

describe('webSearchTool', () => {
    it('is a tool with the correct name', () => {
        expect(webSearchTool.name).toBe('tavily_search')
    })

    it('returns a string result when invoked', async () => {
        const result = await webSearchTool.invoke({ query: 'latest AI news' })
        expect(typeof result).toBe('string')
        expect(result.length).toBeGreaterThan(0)
    })
})
