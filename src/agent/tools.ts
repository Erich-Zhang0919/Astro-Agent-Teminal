import * as fs from 'fs/promises'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { searchFn } from './tools/search'
import { webSearchTool } from './tools/web_search'
import { readFileFn } from './tools/read_file'
import { writeFileFn } from './tools/write_file'
import { execFn } from './tools/exec'
import { runJsFn } from './tools/run_js'
import { runPyFn } from './tools/run_py'
import { webFetchFn } from './tools/web_fetch'
import { loadSkillFn } from './tools/load_skill'

export async function maybePersistedOutput(content: string, toolCallId: string): Promise<string> {
    if (content.length <= 50_000) return content

    const filePath = `./tool_output/tool_output_${encodeURIComponent(toolCallId)}.txt`
    await fs.mkdir('./tool_output', { recursive: true })
    await fs.writeFile(filePath, content, 'utf-8')

    return `<persisted-output>
Output too large (${(content.length / 1024).toFixed(1)}KB).
Full output saved to: ${filePath}
If you need the complete content, it is recommended to read it in segments

Preview (first 2KB):
${content.slice(0, 2000)}
...
</persisted-output>`
}

export const tools = [
    tool(searchFn, {
        name: 'search',
        description: 'Call to surf the web.',
        schema: z.object({
            query: z.string().describe('The query to use in your search.'),
        }),
    }),
    webSearchTool,
    tool(readFileFn, {
        name: 'read_file',
        description: 'Read the contents of a local file. Only files within the current working directory are accessible.',
        schema: z.object({
            file_path: z.string().describe('Relative path to the file from the current working directory.'),
        }),
    }),
    tool(writeFileFn, {
        name: 'write_file',
        description: 'Create a new file or overwrite an existing file within the current working directory.',
        schema: z.object({
            file_path: z.string().describe('Relative path to the file from the current working directory.'),
            content: z.string().describe('The content to write into the file.'),
        }),
    }),
    tool(execFn, {
        name: 'exec',
        description: 'Execute a shell command in the current working directory. Dangerous operations (rm, sudo, kill, shutdown, etc.) are blocked.',
        schema: z.object({
            command: z.string().describe('The shell command to execute.'),
        }),
    }),
    tool(runJsFn, {
        name: 'run_js',
        description: 'Execute JavaScript code using Node.js and return the output. Returns stdout/stderr or an error message if Node.js is not installed.',
        schema: z.object({
            code: z.string().describe('The JavaScript code to execute.'),
        }),
    }),
    tool(runPyFn, {
        name: 'run_py',
        description: 'Execute Python code using python3 and return the output. Returns stdout/stderr or an error message if Python 3 is not installed.',
        schema: z.object({
            code: z.string().describe('The Python code to execute.'),
        }),
    }),
    tool(webFetchFn, {
        name: 'web_fetch',
        description: 'Fetch the content of a URL (http/https). Returns the raw response body as text, or an error message if the request fails.',
        schema: z.object({
            url: z.string().describe('The full URL to fetch (must start with http:// or https://).'),
        }),
    }),
    tool(loadSkillFn, {
        name: 'load_skill',
        description:
            'Load the full SKILL.md instructions for ONE skill by name. Call this when a user request matches an available skill, before acting. Only one skill can be loaded per call.',
        schema: z.object({
            name: z.string().describe('The exact name of the skill to load.'),
        }),
    }),
]
