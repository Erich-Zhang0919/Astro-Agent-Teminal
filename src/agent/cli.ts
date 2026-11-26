import { installIfNeeded } from '../install'
import { validateStartupConfiguration } from './config'

export async function runCli(argv: string[]): Promise<void> {
    if (await installIfNeeded()) return
    validateStartupConfiguration()
    const { buildProgram } = await import('./command')
    const commandArgv = argv.length === 2 ? [...argv, 'chat'] : argv
    await buildProgram().parseAsync(commandArgv)
}
