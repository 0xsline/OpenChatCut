import { isExternalGlobalReadTool, isExternalReadTool } from './external-tool-policy';
import { TOOL_SCHEMAS } from './tools';

/** Q&A mode may inspect project/skill state, but never receives mutating tools. */
export const ASK_MODE_TOOL_SCHEMAS = TOOL_SCHEMAS.filter(
  (tool) => isExternalGlobalReadTool(tool.name) || isExternalReadTool(tool.name),
);
