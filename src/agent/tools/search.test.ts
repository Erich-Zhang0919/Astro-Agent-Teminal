import { searchFn } from './search'

describe('searchFn', () => {
    it('returns foggy weather for "sf"', async () => {
        const result = await searchFn({ query: 'weather in sf' })
        expect(result).toBe("It's 60 degrees and foggy.")
    })

    it('returns foggy weather for "san francisco"', async () => {
        const result = await searchFn({ query: 'weather in san francisco' })
        expect(result).toBe("It's 60 degrees and foggy.")
    })

    it('returns sunny weather for other locations', async () => {
        const result = await searchFn({ query: 'weather in new york' })
        expect(result).toBe("It's 90 degrees and sunny.")
    })

    it('is case-insensitive', async () => {
        const result = await searchFn({ query: 'Weather in SF today' })
        expect(result).toBe("It's 60 degrees and foggy.")
    })
})
