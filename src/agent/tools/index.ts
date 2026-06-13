import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { searchFn } from './search'
import { webSearchTool } from './web_search'
import { readFileFn } from './read_file'
import { writeFileFn } from './write_file'
import { execFn } from './exec'
import { runJsFn } from './run_js'
import { webFetchFn } from './web_fetch'

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
    tool(webFetchFn, {
        name: 'web_fetch',
        description: 'Fetch the content of a URL (http/https). Returns the raw response body as text, or an error message if the request fails.',
        schema: z.object({
            url: z.string().describe('The full URL to fetch (must start with http:// or https://).'),
        }),
    }),
]
