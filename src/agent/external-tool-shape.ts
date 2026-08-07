import type { AgentToolSchema } from './tool-schema.js';
import {
  isExternalGlobalReadTool,
  isExternalReadTool,
  isExternalRealTool,
} from './external-tool-policy.js';

interface ExternalToolAnnotation {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ExternalRegisteredTool extends AgentToolSchema {
  annotations?: ExternalToolAnnotation;
}

const SESSION_ID_PROPERTY = {
  type: 'string',
  description: 'Session id returned by begin_edit_session. All editor tools run against this draft.',
};

export const EXTERNAL_SESSION_TOOLS: readonly ExternalRegisteredTool[] = [
  {
    name: 'begin_edit_session',
    description: 'Start an isolated OpenChatCut edit draft. Manual mode waits for project approval; auto mode applies all staged edits when review_edit_session is called.',
    input_schema: {
      type: 'object',
      properties: {
        clientName: { type: 'string', description: 'Display name shown on the review card, such as Codex or Claude.' },
        approvalMode: {
          type: 'string',
          enum: ['manual', 'auto'],
          description: 'manual (default) requires approval in OpenChatCut; auto applies the full draft without human approval.',
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'get_edit_session',
    description: 'Read session status: drafting/awaiting_review or terminal applied/rejected/cancelled/stale/failed.',
    input_schema: {
      type: 'object',
      properties: { editSessionId: SESSION_ID_PROPERTY },
      required: ['editSessionId'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'review_edit_session',
    description: 'Finish drafting. Manual sessions show a review card; auto sessions immediately apply all staged edits.',
    input_schema: {
      type: 'object',
      properties: {
        editSessionId: SESSION_ID_PROPERTY,
        summary: { type: 'string', description: 'Short human-readable summary of the staged edit.' },
      },
      required: ['editSessionId'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'discard_edit_session',
    description: 'Cancel a draft or pending review without changing the live OpenChatCut project.',
    input_schema: {
      type: 'object',
      properties: { editSessionId: SESSION_ID_PROPERTY },
      required: ['editSessionId'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

function withSession(tool: AgentToolSchema, description: string): ExternalRegisteredTool {
  return {
    ...tool,
    description,
    input_schema: {
      ...tool.input_schema,
      properties: { ...tool.input_schema.properties, editSessionId: SESSION_ID_PROPERTY },
      required: [...new Set([...(tool.input_schema.required ?? []), 'editSessionId'])],
    },
  };
}

export function externalGlobalReadSchemas(tools: readonly AgentToolSchema[]): ExternalRegisteredTool[] {
  return tools.filter((tool) => isExternalGlobalReadTool(tool.name)).map((tool) => ({
    ...tool,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }));
}

export function externalDraftSchemas(tools: readonly AgentToolSchema[]): ExternalRegisteredTool[] {
  return tools.map((tool) => ({
    ...withSession(
      tool,
      `${tool.description ?? tool.name} ${isExternalReadTool(tool.name) ? 'Reads' : 'Edits'} the edit-session draft; pass editSessionId.`,
    ),
    annotations: {
      readOnlyHint: isExternalReadTool(tool.name),
      destructiveHint: false,
      idempotentHint: isExternalReadTool(tool.name),
      openWorldHint: false,
    },
  }));
}

export function externalRealSchemas(tools: readonly AgentToolSchema[]): ExternalRegisteredTool[] {
  return tools.filter((tool) => isExternalRealTool(tool.name)).map((tool) => ({
    ...withSession(
      tool,
      `${tool.description ?? tool.name} Acts on the live project; the first call per session needs your confirmation in OpenChatCut. Pass editSessionId.`,
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }));
}
