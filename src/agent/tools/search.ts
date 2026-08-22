import chalk from 'chalk'

export async function searchFn({ query }: { query: string }): Promise<string> {
    console.log(chalk.gray(`\n[Tool] search called: "${query}"`))

    if (
        query.toLowerCase().includes('sf') ||
        query.toLowerCase().includes('san francisco')
    ) {
        return "It's 60 degrees and foggy."
    }
    return "It's 90 degrees and sunny."
}
