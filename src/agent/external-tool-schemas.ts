import { TOOL_SCHEMAS } from './tools.js';
import { validateAgentToolInvocation } from './execution-policy.js';
import { ExternalEditSessionOutcomeError } from './external-edit-session.js';
import type { AgentToolSchema } from './tool-schema.js';
import { isExternalDraftTool } from './external-tool-policy.js';
import {
  EXTERNAL_SESSION_TOOLS,
  externalDraftSchemas,
  externalGlobalReadSchemas,
  externalRealSchemas,
  type ExternalRegisteredTool,
} from './external-tool-shape.js';

function withoutEditSessionId(schema: AgentToolSchema): AgentToolSchema {
  const properties = { ...(schema.input_schema.properties ?? {}) };
  delete properties.editSessionId;
  return {
    ...schema,
    input_schema: {
      ...schema.input_schema,
      properties,
      required: schema.input_schema.required?.filter((name) => name !== 'editSessionId'),
    },
  };
}

/** MCP-facing catalog: stateless reads, lifecycle controls, then session-bound editor tools. */
export function externalToolSchemas(): ExternalRegisteredTool[] {
  const globalReadTools = externalGlobalReadSchemas(TOOL_SCHEMAS);
  const editorTools = externalDraftSchemas(
    TOOL_SCHEMAS.filter((tool) => isExternalDraftTool(tool.name)),
  );
  const realTools = externalRealSchemas(TOOL_SCHEMAS);
  return [...globalReadTools, ...EXTERNAL_SESSION_TOOLS, ...editorTools, ...realTools];
}

const EXTERNAL_ACTIVE_CATALOG = externalToolSchemas().map(withoutEditSessionId);

export function validateExternalInvocation(
  name: string,
  rawArgs: Record<string, unknown>,
): Record<string, unknown> {
  const args = { ...rawArgs };
  delete args.editSessionId;
  const schema = EXTERNAL_ACTIVE_CATALOG.find((candidate) => candidate.name === name)
    ?? { name, input_schema: { type: 'object' } as const };
  const validation = validateAgentToolInvocation(schema, args, EXTERNAL_ACTIVE_CATALOG);
  if (!validation.ok) {
    throw new ExternalEditSessionOutcomeError('rejected', validation.error);
  }
  return validation.args;
}

export type { ExternalRegisteredTool } from './external-tool-shape.js';
