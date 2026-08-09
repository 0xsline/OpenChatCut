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
    description: 'Start an isolated OpenChatCut edit draft. Manual mode waits for proposal review; auto mode applies only the staged proposal at review_edit_session. Real-project tools always require separate confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        clientName: { type: 'string', description: 'Display name shown on the review card, such as Codex or Claude.' },
        approvalMode: {
          type: 'string',
          enum: ['manual', 'auto'],
          description: 'manual (default) requires proposal approval in OpenChatCut; auto applies the reviewed draft only and never bypasses real-tool confirmation.',
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
    description: 'Finish drafting. Manual sessions show a review card; auto sessions immediately apply all staged proposal edits. This does not approve real-project tools.',
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
  return tools.map((tool) => {
    const readOnly = isExternalReadTool(tool.name);
    const multiplexesPersistentActions = tool.name === 'manage_design_style';
    const scopeDescription = multiplexesPersistentActions
      ? 'Read and ProjectDoc actions use the edit-session draft; owned-library writes act on live local data and require one-shot OpenChatCut confirmation. Pass editSessionId.'
      : `${readOnly ? 'Reads' : 'Edits'} the edit-session draft; pass editSessionId.`;
    return {
      ...withSession(
        tool,
        `${tool.description ?? tool.name} ${scopeDescription}`,
      ),
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: multiplexesPersistentActions,
        idempotentHint: readOnly,
        openWorldHint: multiplexesPersistentActions,
      },
    };
  });
}

export function externalRealSchemas(tools: readonly AgentToolSchema[]): ExternalRegisteredTool[] {
  return tools.filter((tool) => isExternalRealTool(tool.name)).map((tool) => ({
    ...withSession(
      tool,
      `${tool.description ?? tool.name} Acts on the live project. Every invocation needs a one-shot OpenChatCut confirmation bound to this session/run, tool, and exact argument digest; changed arguments require a new confirmation. Pass editSessionId.`,
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }));
}
