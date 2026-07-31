import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setImmediate as delayImmediate } from 'node:timers/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  cancelEditorCallsForOwner,
  connectedProjectIds,
  editorBinding,
  editorBindingIdentityMatches,
  editSessionOwnerMatches,
  editorBindingMatches,
  editorStatuses,
  ExternalEditorCallError,
  invokeEditorTool,
  onRegisteredToolsChanged,
  registeredTools,
  type EditorBinding,
} from './broker.ts';
import { createExternalProject, listExternalProjects } from './projects.ts';

export const OPENCHATCUT_SKILL_BASELINE = '2026-07-27.1';
export const MCP_SESSION_IDLE_LIMIT_MS = 60 * 60 * 1000;
export const MCP_SESSION_COUNT_LIMIT = 64;

const PROJECT_SELECTOR = {
  type: 'string',
  description: 'OpenChatCut project id. It must match the project bound to this MCP transport session.',
};

const CONTROL_TOOLS: Tool[] = [
  {
    name: 'openchatcut_status',
    description: 'Show connected OpenChatCut editors, this transport session binding, and capability status.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_projects',
    description: 'List OpenChatCut projects, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        includeDeleted: { type: 'boolean' },
        editorBaseUrl: { type: 'string' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'create_project',
    description: 'Create an empty OpenChatCut project with one active timeline and one video track.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        compositionWidth: { type: 'number' },
        compositionHeight: { type: 'number' },
        fps: { type: 'number' },
        editorBaseUrl: { type: 'string' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'target_project',
    description: 'Permanently bind this MCP transport session to one connected project/editor/revision.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, editorBaseUrl: { type: 'string' } },
      required: ['projectId'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_editor_url',
    description: 'Return the OpenChatCut editor URL for this session project or an explicitly named project.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, editorBaseUrl: { type: 'string' } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

interface McpSession {
  id: string | null;
  server: Server | null;
  transport: StreamableHTTPServerTransport;
  binding: EditorBinding | null;
  staleReason: string | null;
  lastUsed: number;
}

const sessions = new Map<string, McpSession>();

function editorUrl(args: Record<string, unknown>, projectId: string, fallbackBase: string): string {
  const base = String(args.editorBaseUrl ?? '').trim() || fallbackBase;
  return `${base.replace(/\/+$/, '')}/#/editor/${encodeURIComponent(projectId)}`;
}

export function mcpTools(): Tool[] {
  const controls = new Set(CONTROL_TOOLS.map((tool) => tool.name));
  const editorTools = registeredTools()
    .filter((tool) => !controls.has(tool.name))
    .map((tool): Tool => ({
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
  return [...CONTROL_TOOLS, ...editorTools];
}

function requestedProjectId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function defaultProjectId(): string {
  const connected = connectedProjectIds();
  if (connected.length === 1) return connected[0];
  if (!connected.length) {
    throw new ExternalEditorCallError(
      'rejected',
      'No OpenChatCut editor is connected. Open the target project in OpenChatCut first.',
    );
  }
  throw new ExternalEditorCallError(
    'rejected',
    'Multiple OpenChatCut projects are open; call target_project with the intended project.',
  );
}

function markSessionStale(session: McpSession, message: string): void {
  if (!session.staleReason) session.staleReason = message;
  if (session.id) cancelEditorCallsForOwner(session.id, 'stale', message);
}

function validateSessionBinding(
  session: McpSession,
  allowRevisionDrift = false,
): EditorBinding | null {
  if (session.staleReason) {
    throw new ExternalEditorCallError('stale', session.staleReason);
  }
  if (!session.binding) return null;
  const matches = allowRevisionDrift
    ? editorBindingIdentityMatches(session.binding)
    : editorBindingMatches(session.binding);
  if (!matches) {
    const message = `MCP session binding for project ${session.binding.projectId} is stale. Re-initialize the MCP session.`;
    markSessionStale(session, message);
    throw new ExternalEditorCallError('stale', message);
  }
  return session.binding;
}

function bindSession(
  session: McpSession,
  requested: unknown,
  allowRevisionDrift = false,
): EditorBinding {
  const projectId = requestedProjectId(requested) ?? session.binding?.projectId ?? defaultProjectId();
  if (session.binding) {
    if (session.binding.projectId !== projectId) {
      throw new ExternalEditorCallError(
        'rejected',
        `This MCP session is bound to project ${session.binding.projectId}; it cannot operate project ${projectId}.`,
      );
    }
    return validateSessionBinding(session, allowRevisionDrift)!;
  }
  const binding = editorBinding(projectId);
  if (!binding || !editorBindingMatches(binding)) {
    throw new ExternalEditorCallError(
      'rejected',
      `Project ${projectId} is not open in a connected OpenChatCut editor.`,
    );
  }
  session.binding = binding;
  return binding;
}

function projectForRead(session: McpSession, requested: unknown): string {
  const projectId = requestedProjectId(requested) ?? session.binding?.projectId ?? defaultProjectId();
  if (session.binding && session.binding.projectId !== projectId) {
    throw new ExternalEditorCallError(
      'rejected',
      `This MCP session is bound to project ${session.binding.projectId}; it cannot address project ${projectId}.`,
    );
  }
  return projectId;
}

async function callControlTool(
  session: McpSession,
  name: string,
  args: Record<string, unknown>,
  baseUrl: string,
): Promise<unknown | undefined> {
  if (name === 'openchatcut_status') {
    return {
      connectedProjectIds: connectedProjectIds(),
      editors: editorStatuses(),
      sessionBinding: session.binding,
      toolCount: mcpTools().length,
    };
  }
  if (name === 'list_projects') {
    const projects = await listExternalProjects(args.includeDeleted === true);
    return projects.map((project) => ({
      ...project,
      editorUrl: editorUrl(args, project.id, baseUrl),
    }));
  }
  if (name === 'create_project') {
    if (session.binding) {
      throw new ExternalEditorCallError(
        'rejected',
        'A project-bound MCP session cannot create or switch to another project. Start a new MCP session.',
      );
    }
    const project = await createExternalProject(args);
    return { ...project, editorUrl: editorUrl(args, project.id, baseUrl) };
  }
  if (name === 'target_project') {
    const projectId = requestedProjectId(args.projectId);
    if (!projectId) throw new ExternalEditorCallError('rejected', 'projectId is required');
    const binding = bindSession(session, projectId);
    return { ok: true, binding, editorUrl: editorUrl(args, binding.projectId, baseUrl) };
  }
  if (name === 'get_editor_url') {
    const projectId = projectForRead(session, args.projectId);
    return { projectId, editorUrl: editorUrl(args, projectId, baseUrl) };
  }
  return undefined;
}

async function callTool(
  session: McpSession,
  name: string,
  rawArgs: unknown,
  baseUrl: string,
): Promise<unknown> {
  const args: Record<string, unknown> = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
    ? { ...rawArgs as Record<string, unknown> }
    : {};
  const allowRevisionDrift = name === 'get_edit_session'
    && Boolean(
      session.id
      && session.binding
      && editSessionOwnerMatches(session.id, session.binding, args.editSessionId),
    );
  validateSessionBinding(session, allowRevisionDrift);
  const control = await callControlTool(session, name, args, baseUrl);
  if (control !== undefined) return control;
  if (!session.id) {
    throw new ExternalEditorCallError('failed', 'MCP session initialization is incomplete.');
  }
  const binding = bindSession(session, args.editorProjectId, allowRevisionDrift);
  delete args.editorProjectId;
  if ((name === 'track_progress' || name === 'track_export') && args.action === 'wait') {
    const requested = Number(args.timeoutSeconds);
    args.timeoutSeconds = Math.min(45, requested > 0 ? requested : 45);
  }
  return invokeEditorTool(session.id, binding, name, args);
}

function toolError(error: unknown): {
  outcome: 'rejected' | 'cancelled' | 'stale' | 'failed';
  message: string;
} {
  return {
    outcome: error instanceof ExternalEditorCallError ? error.outcome : 'failed',
    message: error instanceof Error ? error.message : String(error),
  };
}

function makeServer(baseUrl: string, session: McpSession): Server {
  const server = new Server(
    { name: 'openchatcut', version: '1.0.0' },
    {
      capabilities: { tools: { listChanged: true } },
      instructions: [
        `OpenChatCut external skill baseline: ${OPENCHATCUT_SKILL_BASELINE}. Update with npx skills update openchatcut when the installed skill is older.`,
        'Bind this MCP transport with target_project before editing; the project, editor instance, and base revision cannot change within the session.',
        'Call begin_edit_session first with approvalMode manual (default) or auto, then pass its editSessionId to every editor tool.',
        'Call review_edit_session when the draft is ready.',
        'Manual sessions wait for approval in OpenChatCut; auto sessions apply the complete draft during review_edit_session. Do not claim success until status is applied.',
        'If a session becomes stale, cancelled, or failed, start a new MCP session instead of reusing it.',
      ].join(' '),
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await callTool(session, request.params.name, request.params.arguments, baseUrl);
      return {
        content: toMcpContent(result),
        structuredContent: toStructuredContent(result),
      };
    } catch (error) {
      if (
        request.params.name !== 'get_edit_session'
        && error instanceof ExternalEditorCallError
        && error.outcome === 'stale'
      ) {
        markSessionStale(session, error.message);
      }
      const result = toolError(error);
      return {
        isError: true,
        content: toMcpContent(result),
        structuredContent: result,
      };
    }
  });
  return server;
}

function forgetSession(
  session: McpSession,
  outcome: 'cancelled' | 'stale' | 'failed',
  message: string,
): void {
  const id = session.id;
  if (!id) return;
  if (sessions.get(id) === session) sessions.delete(id);
  cancelEditorCallsForOwner(id, outcome, message);
}

function evictSession(
  id: string,
  outcome: 'cancelled' | 'stale' | 'failed' = 'cancelled',
  message = 'MCP transport session was evicted before the editor call completed.',
): void {
  const session = sessions.get(id);
  if (!session) return;
  forgetSession(session, outcome, message);
  void delayImmediate()
    .then(() => (session.server ? session.server.close() : session.transport.close()))
    .catch(() => undefined);
}

export function pruneMcpSessions(now = Date.now()): void {
  for (const [id, session] of [...sessions]) {
    if (now - session.lastUsed > MCP_SESSION_IDLE_LIMIT_MS) {
      evictSession(id, 'cancelled', 'MCP transport session expired while the editor call was pending.');
    }
  }
  if (sessions.size <= MCP_SESSION_COUNT_LIMIT) return;
  const oldest = [...sessions.entries()].sort((left, right) => left[1].lastUsed - right[1].lastUsed);
  for (const [id] of oldest.slice(0, sessions.size - MCP_SESSION_COUNT_LIMIT)) {
    evictSession(id, 'cancelled', 'MCP transport session was evicted by the session count limit.');
  }
}

setInterval(() => pruneMcpSessions(), 10 * 60 * 1000).unref?.();

onRegisteredToolsChanged(() => {
  for (const { server } of sessions.values()) {
    if (server) void server.sendToolListChanged().catch(() => undefined);
  }
});

function sessionIdOf(req: IncomingMessage): string | null {
  const value = req.headers['mcp-session-id'];
  return typeof value === 'string' && value ? value : null;
}

function sendSessionError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: status === 404 ? -32001 : -32000, message },
    id: null,
  }));
}

async function startMcpSession(
  req: IncomingMessage,
  res: ServerResponse,
  baseUrl: string,
): Promise<void> {
  let session: McpSession;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    onsessioninitialized: (sessionId) => {
      session.id = sessionId;
      session.lastUsed = Date.now();
      sessions.set(sessionId, session);
      pruneMcpSessions(session.lastUsed);
    },
  });
  session = {
    id: null,
    server: null,
    transport,
    binding: null,
    staleReason: null,
    lastUsed: Date.now(),
  };
  const server = makeServer(baseUrl, session);
  session.server = server;
  transport.onclose = () => {
    forgetSession(
      session,
      'cancelled',
      'MCP transport session closed before the editor call completed.',
    );
  };
  await server.connect(transport);
  await transport.handleRequest(req, res);
  if (!transport.sessionId) await server.close();
}

interface EmbeddedImage {
  base64: string;
  frame?: number;
  mimeType?: string;
}

function embeddedImages(result: unknown): EmbeddedImage[] {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
  if (!('__images' in result)) return [];
  const images = result.__images;
  if (!Array.isArray(images)) return [];
  return images.filter((image): image is EmbeddedImage => (
    image !== null
    && typeof image === 'object'
    && 'base64' in image
    && typeof image.base64 === 'string'
  ));
}

export function toStructuredContent(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { result };
  const record = result as Record<string, unknown>;
  const images = embeddedImages(record);
  if (!images.length) return record;
  const { __images: _images, ...rest } = record;
  return {
    ...rest,
    images: images.map((image) => ({
      frame: image.frame,
      mimeType: image.mimeType ?? 'image/jpeg',
    })),
  };
}

export function toMcpContent(result: unknown): CallToolResult['content'] {
  const structured = toStructuredContent(result);
  return [
    { type: 'text', text: JSON.stringify(structured) },
    ...embeddedImages(result).map((image) => ({
      type: 'image' as const,
      data: image.base64,
      mimeType: image.mimeType ?? 'image/jpeg',
    })),
  ];
}

export function mcpSessionsForTest(): Array<{
  id: string;
  lastUsed: number;
  binding: EditorBinding | null;
  staleReason: string | null;
}> {
  return [...sessions.entries()].map(([id, session]) => ({
    id,
    lastUsed: session.lastUsed,
    binding: session.binding ? { ...session.binding } : null,
    staleReason: session.staleReason,
  }));
}

export function setMcpSessionLastUsedForTest(id: string, lastUsed: number): void {
  const session = sessions.get(id);
  if (session) session.lastUsed = lastUsed;
}

export function resetMcpSessionsForTest(): void {
  for (const id of [...sessions.keys()]) evictSession(id);
}

export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  baseUrl: string,
): Promise<void> {
  const sessionId = sessionIdOf(req);
  if (sessionId) {
    const now = Date.now();
    pruneMcpSessions(now);
    const session = sessions.get(sessionId);
    if (!session) {
      sendSessionError(res, 404, 'MCP session not found or expired');
      return;
    }
    if (req.method === 'DELETE') {
      forgetSession(
        session,
        'cancelled',
        'MCP transport session closed before the editor call completed.',
      );
      // Let the cancelled tool request flush its terminal response before the
      // transport processes the session-termination request.
      await delayImmediate();
      await session.transport.handleRequest(req, res);
      return;
    }
    session.lastUsed = now;
    await session.transport.handleRequest(req, res);
    return;
  }
  if (req.method !== 'POST') {
    sendSessionError(res, 400, 'MCP session id is required');
    return;
  }
  await startMcpSession(req, res, baseUrl);
}
