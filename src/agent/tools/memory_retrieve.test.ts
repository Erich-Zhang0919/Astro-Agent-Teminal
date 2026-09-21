const mockAll = jest.fn()
const mockPrepare = jest.fn(() => ({ all: mockAll }))

jest.mock('../db', () => ({
    db: { prepare: mockPrepare },
}))

import { memoryRetrieveFn } from './memory_retrieve'

describe('memoryRetrieveFn', () => {
    beforeEach(() => {
        mockAll.mockReset()
        mockPrepare.mockClear()
    })

    it('normalizes keywords and retrieves memories with an OR query', async () => {
        mockAll.mockReturnValue([{ id: 1, content: '用户喜欢西瓜' }])

        const result = JSON.parse(await memoryRetrieveFn({
            keywords: [' 水果 ', '偏好', '水果'],
        }))

        expect(mockPrepare).toHaveBeenCalledTimes(1)
        expect(mockAll).toHaveBeenCalledWith({
            query: '"水果" OR "偏好"',
        })
        expect(result).toEqual({
            keywords: ['水果', '偏好'],
            count: 1,
            memories: [{ id: 1, content: '用户喜欢西瓜' }],
        })
    })

    it('escapes double quotes in FTS phrases', async () => {
        mockAll.mockReturnValue([])

        await memoryRetrieveFn({ keywords: ['say "hello"'] })

        expect(mockAll).toHaveBeenCalledWith({
            query: '"say ""hello"""',
        })
    })

    it('rejects an empty keyword list', async () => {
        await expect(memoryRetrieveFn({ keywords: [' ', ''] })).rejects.toThrow(
            'Cannot retrieve memory without at least one keyword.',
        )
        expect(mockPrepare).not.toHaveBeenCalled()
    })
})
