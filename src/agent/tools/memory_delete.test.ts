const mockRun = jest.fn()
const mockPrepare = jest.fn(() => ({ run: mockRun }))

jest.mock('../db', () => ({
    db: { prepare: mockPrepare },
}))

import { memoryDeleteFn } from './memory_delete'

describe('memoryDeleteFn', () => {
    beforeEach(() => {
        mockRun.mockReset()
        mockPrepare.mockClear()
    })

    it('deletes a memory by id', async () => {
        mockRun.mockReturnValue({ changes: 1 })

        const result = await memoryDeleteFn({ id: 42 })

        expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining(
            'DELETE FROM memory',
        ))
        expect(mockRun).toHaveBeenCalledWith(42)
        expect(result).toBe('Memory deleted successfully: id=42')
    })

    it('reports when the memory does not exist', async () => {
        mockRun.mockReturnValue({ changes: 0 })

        const result = await memoryDeleteFn({ id: 999 })

        expect(result).toBe('Memory not found: id=999')
    })
})
