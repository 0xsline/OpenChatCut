import { TOOL_SCHEMAS } from './tools.js';
import { isExternalDraftTool } from './external-tool-policy.js';
import {
  EXTERNAL_SESSION_TOOLS,
  externalDraftSchemas,
  externalGlobalReadSchemas,
  externalRealSchemas,
  type ExternalRegisteredTool,
} from './external-tool-shape.js';

/** MCP-facing catalog: stateless reads, lifecycle controls, then session-bound editor tools. */
export function externalToolSchemas(): ExternalRegisteredTool[] {
  const globalReadTools = externalGlobalReadSchemas(TOOL_SCHEMAS);
  const editorTools = externalDraftSchemas(
    TOOL_SCHEMAS.filter((tool) => isExternalDraftTool(tool.name)),
  );
  const realTools = externalRealSchemas(TOOL_SCHEMAS);
  return [...globalReadTools, ...EXTERNAL_SESSION_TOOLS, ...editorTools, ...realTools];
}

export type { ExternalRegisteredTool } from './external-tool-shape.js';
