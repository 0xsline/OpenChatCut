import { isExternalGlobalReadTool, isExternalReadTool } from './external-tool-policy';
import { TOOL_SCHEMAS } from './tools';

/** Q&A mode may inspect project/skill state, but never receives mutating tools. */
const ASK_MODE_TOOL_NAMES = new Set([
  ...TOOL_SCHEMAS
    .filter((tool) => isExternalGlobalReadTool(tool.name) || isExternalReadTool(tool.name))
    .map((tool) => tool.name),
  'ToolSearch',
]);

/** Q&A mode may inspect project/skill state and discover read tools, but never receives mutations. */
export const ASK_MODE_TOOL_SCHEMAS = TOOL_SCHEMAS.filter((tool) => ASK_MODE_TOOL_NAMES.has(tool.name));
