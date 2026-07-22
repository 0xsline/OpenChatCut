import type { AgentToolSchema } from './tool-schema';
import { TOOL_SCHEMAS } from './tools';
import { isExternalDraftTool, isExternalReadTool } from './external-tool-policy';

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

const SESSION_TOOLS: ExternalRegisteredTool[] = [
  {
    name: 'begin_edit_session',
    description: 'Start an isolated OpenChatCut edit draft. The live project is not changed until the user approves it in OpenChatCut.',
    input_schema: {
      type: 'object',
      properties: {
        clientName: { type: 'string', description: 'Display name shown on the review card, such as Codex or Claude.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'get_edit_session',
    description: 'Read draft/review/apply status. Poll this after review_edit_session until the user approves or rejects in OpenChatCut.',
    input_schema: {
      type: 'object',
      properties: { editSessionId: SESSION_ID_PROPERTY },
      required: ['editSessionId'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'review_edit_session',
    description: 'Finish drafting and show one review card inside OpenChatCut. This does not apply edits; the user decides in the project UI.',
    input_schema: {
      type: 'object',
      properties: {
        editSessionId: SESSION_ID_PROPERTY,
        summary: { type: 'string', description: 'Short human-readable summary of the staged edit.' },
      },
      required: ['editSessionId'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'discard_edit_session',
    description: 'Discard a draft or pending review without changing the live OpenChatCut project.',
    input_schema: {
      type: 'object',
      properties: { editSessionId: SESSION_ID_PROPERTY },
      required: ['editSessionId'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

function requiredWithSession(required: string[] | undefined): string[] {
  return [...new Set([...(required ?? []), 'editSessionId'])];
}

/** MCP-facing catalog: lifecycle controls plus session-bound editor tools. */
export function externalToolSchemas(): ExternalRegisteredTool[] {
  const editorTools = TOOL_SCHEMAS.filter((tool) => isExternalDraftTool(tool.name)).map((tool): ExternalRegisteredTool => ({
    ...tool,
    description: `${tool.description ?? tool.name} ${isExternalReadTool(tool.name) ? 'Reads' : 'Edits'} the edit-session draft; pass editSessionId.`,
    input_schema: {
      ...tool.input_schema,
      properties: { ...tool.input_schema.properties, editSessionId: SESSION_ID_PROPERTY },
      required: requiredWithSession(tool.input_schema.required),
    },
    annotations: {
      readOnlyHint: isExternalReadTool(tool.name),
      destructiveHint: false,
      idempotentHint: isExternalReadTool(tool.name),
      openWorldHint: false,
    },
  }));
  return [...SESSION_TOOLS, ...editorTools];
}
