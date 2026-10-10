import { TavilySearch } from '@langchain/tavily'
import { withPermissionLevel } from '../permission/util'

export const webSearchTool = withPermissionLevel(new TavilySearch({
    maxResults: 3,
    topic: 'general',
}), 'network')
