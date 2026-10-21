import { TavilySearch } from '@langchain/tavily'
import { loadTavilyApiKey } from '../config'
import { withPermissionLevel } from '../permission/util'

export const webSearchTool = withPermissionLevel(new TavilySearch({
    tavilyApiKey: loadTavilyApiKey(),
    maxResults: 3,
    topic: 'general',
}), 'network')
