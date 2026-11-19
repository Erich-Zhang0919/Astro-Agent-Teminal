import { runCli } from './cli'
import { installIfNeeded } from '../install'
import { validateStartupConfiguration } from './config'

const mockParse = jest.fn()
const mockLoadCommand = jest.fn()
jest.mock('../install', () => ({ installIfNeeded: jest.fn() }))
jest.mock('./config', () => ({ validateStartupConfiguration: jest.fn() }))
jest.mock('./command', () => {
    mockLoadCommand()
    return { buildProgram: () => ({ parseAsync: mockParse }) }
})

it('finishes first-run setup before loading the agent or parsing commands', async () => {
    jest.mocked(installIfNeeded).mockResolvedValue(true)
    await runCli(['node', 'astro', 'chat'])
    expect(mockLoadCommand).not.toHaveBeenCalled()
    expect(mockParse).not.toHaveBeenCalled()
    expect(validateStartupConfiguration).not.toHaveBeenCalled()
})

it('runs the original command when the configuration exists', async () => {
    jest.mocked(installIfNeeded).mockResolvedValue(false)
    const argv = ['node', 'astro', 'ask', 'hello']
    await runCli(argv)
    expect(validateStartupConfiguration).toHaveBeenCalledTimes(1)
    expect(mockParse).toHaveBeenCalledWith(argv)
})

it('checks configuration before loading commands or starting a session', async () => {
    jest.mocked(installIfNeeded).mockResolvedValue(false)
    jest.mocked(validateStartupConfiguration).mockImplementationOnce(() => {
        expect(mockLoadCommand).not.toHaveBeenCalled()
        throw new Error('configuration incomplete')
    })
    await expect(runCli(['node', 'astro', 'chat'])).rejects.toThrow('configuration incomplete')
    expect(mockLoadCommand).not.toHaveBeenCalled()
    expect(mockParse).not.toHaveBeenCalled()
})

it('propagates installation failure without starting a session', async () => {
    jest.mocked(installIfNeeded).mockRejectedValue(new Error('download failed'))
    await expect(runCli(['node', 'astro', 'chat'])).rejects.toThrow('download failed')
    expect(mockParse).not.toHaveBeenCalled()
})
