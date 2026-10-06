import { buildProfilePrompt } from './prompt'

describe('buildProfilePrompt', () => {
    it('wraps profile information in profile_info tags', () => {
        const prompt = buildProfilePrompt('\n- 姓名：小明\n- 语言：中文\n')

        expect(prompt).toContain('<profile_info>\n- 姓名：小明\n- 语言：中文\n</profile_info>')
    })

    it.each(['', '   \n\t'])('uses empty profile_info tags when profile information is empty', (profileInfo) => {
        const prompt = buildProfilePrompt(profileInfo)

        expect(prompt).toContain('<profile_info></profile_info>')
    })
})
