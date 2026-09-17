import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { connectedProjectIds, editorStatuses, registeredTools } from './broker.ts';
import { bindingMode } from './mcp-binding.ts';
import { MCP_CONTROL_TOOL_NAMES, MCP_CONTROL_TOOLS } from './mcp-controls.ts';
import { offlineExternalToolSchemas } from './offline-tools.ts';
import { mcpSessionStatus } from './mcp-session-status.ts';
import {
  mcpToolExposureStatus,
  mcpToolListDigest,
  projectMcpToolExposure,
} from './mcp-tool-exposure.ts';
import type { McpSession } from './mcp.ts';

/** The tool catalog a transport session advertises, split out of mcp.ts
 * (transport, binding and dispatch) to keep that file inside the 500-line
 * source gate. */

const PROJECT_SELECTOR = {
  type: 'string',
  description: 'OpenChatCut project id. It must match the project bound to this MCP transport session.',
};

export function fullMcpTools(session?: McpSession): Tool[] {
  const browserTools = registeredTools();
  const hasConnectedBrowser = connectedProjectIds().length > 0;
  const catalog = session?.offline
    ? offlineExternalToolSchemas()
    : hasConnectedBrowser || session?.binding
      ? browserTools
      : offlineExternalToolSchemas();
  const editorTools = catalog.filter((tool) => MCP_CONTROL_TOOL_NAMES[tool.name] !== true).map((tool): Tool => ({
    name: tool.name,
    description: tool.description,
    annotations: tool.annotations,
    inputSchema: {
      ...tool.input_schema,
      properties: {
        ...tool.input_schema.properties,
        editorProjectId: PROJECT_SELECTOR,
      },
    },
  }));
  return [...MCP_CONTROL_TOOLS, ...editorTools];
}

export function mcpTools(session?: McpSession): Tool[] {
  const tools = fullMcpTools(session);
  return session
    ? projectMcpToolExposure(session.exposure, tools, MCP_CONTROL_TOOL_NAMES)
    : tools;
}

export function currentToolList(session: McpSession): Tool[] {
  const tools = mcpTools(session);
  session.toolListDigest = mcpToolListDigest(tools);
  return tools;
}

export function mcpStatus(session: McpSession): Record<string, unknown> {
  const tools = mcpTools(session);
  return mcpSessionStatus({
    connectedProjectIds: connectedProjectIds(),
    editors: editorStatuses(),
    binding: session.binding ?? session.offline?.binding() ?? null,
    bindingMode: bindingMode(session),
    toolCount: tools.length,
    exposure: mcpToolExposureStatus(session.exposure, tools.length, fullMcpTools(session).length),
  });
}
