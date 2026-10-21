jest.mock('../config', () => ({ loadTavilyApiKey: jest.fn(() => 'configured-tavily-key') }))

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
    let webSearchTool: typeof import('./web_search')['webSearchTool']

    beforeEach(() => {
        jest.resetModules()
        webSearchTool = require('./web_search').webSearchTool
    })

    it('passes the configured key directly to Tavily', () => {
        expect(require('../config').loadTavilyApiKey).toHaveBeenCalledTimes(1)
        expect(require('@langchain/tavily').TavilySearch).toHaveBeenCalledWith({
            tavilyApiKey: 'configured-tavily-key',
            maxResults: 3,
            topic: 'general',
        })
    })

    it('reports configuration errors before constructing Tavily', () => {
        jest.resetModules()
        require('../config').loadTavilyApiKey.mockImplementation(() => {
            throw new Error('Invalid Astro configuration at env.TAVILY_API_KEY')
        })
        expect(() => require('./web_search')).toThrow('Invalid Astro configuration at env.TAVILY_API_KEY')
        expect(require('@langchain/tavily').TavilySearch).not.toHaveBeenCalled()
    })

    it('is a tool with the correct name', () => {
        expect(webSearchTool.name).toBe('tavily_search')
        expect(webSearchTool.permission_level).toBe('network')
    })

    it('returns a string result when invoked', async () => {
        const result = await webSearchTool.invoke({ query: 'latest AI news' })
        expect(typeof result).toBe('string')
        expect(result.length).toBeGreaterThan(0)
    })
})
