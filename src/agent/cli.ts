export async function runCli(argv: string[]): Promise<void> {
    const { buildProgram } = await import('./command')
    await buildProgram().parseAsync(argv)
}
