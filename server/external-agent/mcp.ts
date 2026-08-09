import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setImmediate as delayImmediate } from 'node:timers/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  cancelEditorCallsForOwner,
  connectedProjectIds,
  editSessionOwnerMatches,
  editorStatuses,
  ExternalEditorCallError,
  invokeEditorTool,
  onRegisteredToolsChanged,
  registeredTools,
  type EditorBinding,
} from './broker.ts';
import {
  bindingMode,
  bindBrowserForCall,
  boundProjectId,
  markMcpSessionStale,
  projectForRead,
  requestedProjectId,
  targetMcpProject,
  validateBrowserBinding,
  validateOfflineBinding,
  type McpBindingSession,
} from './mcp-binding.ts';
import { MCP_CONTROL_TOOL_NAMES, MCP_CONTROL_TOOLS } from './mcp-controls.ts';
import { offlineExternalToolSchemas } from './offline-tools.ts';
import type { OfflineEditorBinding } from './offline-runtime.ts';
import { createExternalProject, listExternalProjects } from './projects.ts';
import { registerMcpPrompts } from './mcp-prompts.ts';
import {
  activateMcpToolExposure,
  activatedMcpToolNames,
  initialMcpToolExposure,
  mcpToolExposureStatus,
  mcpToolListDigest,
  projectMcpToolExposure,
  requestedMcpToolExposure,
  sendMcpToolListChangedIfChanged,
  type McpToolExposure,
} from './mcp-tool-exposure.ts';
import {
  mcpToolError,
  projectMcpReply,
  toMcpContent,
  toStructuredContent,
} from './mcp-result.ts';
export { toMcpContent, toStructuredContent } from './mcp-result.ts';

export const OPENCHATCUT_SKILL_BASELINE = '2026-08-10.1';
export const MCP_SESSION_IDLE_LIMIT_MS = 60 * 60 * 1000;
export const MCP_SESSION_COUNT_LIMIT = 64;
export const MCP_POST_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

const PROJECT_SELECTOR = {
  type: 'string',
  description: 'OpenChatCut project id. It must match the project bound to this MCP transport session.',
};


interface McpSession extends McpBindingSession {
  server: Server | null;
  transport: StreamableHTTPServerTransport;
  toolListDigest: string;
  exposure: McpToolExposure;
  lastUsed: number;
}

const sessions = new Map<string, McpSession>();

function editorUrl(args: Record<string, unknown>, projectId: string, fallbackBase: string): string {
  const base = String(args.editorBaseUrl ?? '').trim() || fallbackBase;
  return `${base.replace(/\/+$/, '')}/#/editor/${encodeURIComponent(projectId)}`;
}

function fullMcpTools(session?: McpSession): Tool[] {
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
function currentToolList(session: McpSession): Tool[] {
  const tools = mcpTools(session);
  session.toolListDigest = mcpToolListDigest(tools);
  return tools;
}

function mcpStatus(session: McpSession): Record<string, unknown> {
  const mode = bindingMode(session);
  const connected = connectedProjectIds();
  return {
    connectedProjectIds: connected,
    editors: editorStatuses(),
    sessionBinding: session.binding ?? session.offline?.binding() ?? null,
    bindingMode: mode,
    availableToolTier: mode === 'offline' || (!mode && !connected.length) ? 'server-direct' : 'browser',
    offlineFallback: 'Target an existing stored project with no browser owner, then begin with approvalMode="auto".',
    browserRequiredFor: ['visual/canvas inspection', 'generation', 'upload', 'network', 'preset', 'render', 'export', 'manual approval'],
    toolCount: mcpTools(session).length,
    ...mcpToolExposureStatus(session.exposure, mcpTools(session).length, fullMcpTools(session).length),
  };
}

async function callControlTool(
  session: McpSession,
  name: string,
  args: Record<string, unknown>,
  baseUrl: string,
): Promise<unknown | undefined> {
  if (name === 'openchatcut_status') return mcpStatus(session);
  if (name === 'list_projects') {
    const projects = await listExternalProjects(args.includeDeleted === true);
    return projects.map((project) => ({
      ...project,
      editorUrl: editorUrl(args, project.id, baseUrl),
    }));
  }
  if (name === 'create_project') {
    if (boundProjectId(session)) {
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
    const url = editorUrl(args, projectId, baseUrl);
    const binding = await targetMcpProject(session, projectId, url);
    await sendMcpToolListChangedIfChanged(session, mcpTools(session));
    return { ok: true, bindingMode: bindingMode(session), binding, editorUrl: url };
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
  if (session.offline) {
    if (MCP_CONTROL_TOOL_NAMES[name] === true) {
      await validateOfflineBinding(session);
      return callControlTool(session, name, args, baseUrl);
    }
    if (!session.id) throw new ExternalEditorCallError('failed', 'MCP session initialization is incomplete.');
    const requested = requestedProjectId(args.editorProjectId);
    const projectId = session.offline.binding().projectId;
    if (requested && requested !== projectId) {
      throw new ExternalEditorCallError('rejected', `This MCP session is bound to project ${projectId}.`);
    }
    delete args.editorProjectId;
    return session.offline.execute(name, args);
  }
  validateBrowserBinding(session, allowRevisionDrift);
  const control = await callControlTool(session, name, args, baseUrl);
  if (control !== undefined) return control;
  if (!session.id) throw new ExternalEditorCallError('failed', 'MCP session initialization is incomplete.');
  const binding = bindBrowserForCall(session, args.editorProjectId, allowRevisionDrift);
  delete args.editorProjectId;
  if ((name === 'track_progress' || name === 'track_export') && args.action === 'wait') {
    const requested = Number(args.timeoutSeconds);
    args.timeoutSeconds = Math.min(45, requested > 0 ? requested : 45);
  }
  return invokeEditorTool(session.id, binding, name, args);
}
function ensureMcpToolExposed(session: McpSession, name: string): void {
  if (mcpTools(session).some((tool) => tool.name === name)) return;
  throw new ExternalEditorCallError(
    'rejected',
    `Tool "${name}" is not exposed in this MCP session. Call ToolSearch or load_skill first.`,
  );
}

async function activateMcpResult(
  session: McpSession,
  toolName: string,
  result: unknown,
): Promise<unknown> {
  const catalog = fullMcpTools(session);
  const activatedTools = activatedMcpToolNames(toolName, result, catalog);
  const next = activateMcpToolExposure(
    session.exposure,
    toolName,
    result,
    catalog,
  );
  if (next !== session.exposure) {
    session.exposure = next;
    await sendMcpToolListChangedIfChanged(session, mcpTools(session));
  }
  return activatedTools.length && result && typeof result === 'object' && !Array.isArray(result)
    ? { ...result, activatedTools }
    : result;
}



function makeServer(baseUrl: string, session: McpSession): Server {
  const server = new Server(
    { name: 'openchatcut', version: '1.0.0' },
    {
      capabilities: { tools: { listChanged: true }, prompts: {} },
      instructions: [
        `OpenChatCut external skill baseline: ${OPENCHATCUT_SKILL_BASELINE}. Update with npx skills update openchatcut when the installed skill is older.`,
        'Bind this MCP transport with target_project before editing. A connected browser is preferred; an existing stored project can use the offline fallback when no browser owns it.',
        'The target response and openchatcut_status report bindingMode. Offline bindings expose only server-direct data tools and require approvalMode="auto".',
        session.exposure.mode === 'progressive'
          ? 'This client negotiated progressive tool exposure. Call ToolSearch or load_skill to reveal task tools; tools/list_changed is sent when the visible set grows.'
          : 'This client uses the compatibility tool surface. All currently available tools are listed.',
        'Call begin_edit_session first, pass editSessionId to every editor tool, then call review_edit_session. Do not claim success until status is applied.',
        'Manual approval and visual/canvas inspection, generation, upload, network, preset, render, and export tools require opening the returned editorUrl.',
        'Offline review atomically commits the complete draft. A browser takeover or stored-project change makes the session stale with no partial edit.',
        'If a session becomes stale, cancelled, or failed, start a new MCP session instead of reusing it.',
      ].join(' '),
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: currentToolList(session) }));
  registerMcpPrompts(server);
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      ensureMcpToolExposed(session, request.params.name);
      const rawResult = await callTool(
        session,
        request.params.name,
        request.params.arguments,
        baseUrl,
      );
      const activatedResult = await activateMcpResult(
        session,
        request.params.name,
        rawResult,
      );
      const result = projectMcpReply(activatedResult);
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
        markMcpSessionStale(session, error.message);
      }
      const result = mcpToolError(error);
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
  void session.offline?.dispose();
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
  for (const session of sessions.values()) {
    if (session.server && !session.offline) {
      void sendMcpToolListChangedIfChanged(session, mcpTools(session));
    }
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

async function readMcpPostBody(req: IncomingMessage): Promise<unknown> {
  const contentType = typeof req.headers['content-type'] === 'string'
    ? req.headers['content-type'].split(';', 1)[0]!.trim().toLowerCase()
    : '';
  if (contentType !== 'application/json') throw new Error('MCP POST requires application/json');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MCP_POST_BODY_LIMIT_BYTES) throw new Error('MCP request body exceeds 2 MiB');
    chunks.push(buffer);
  }
  if (bytes === 0) throw new Error('MCP request body is empty');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('MCP request body is invalid JSON');
  }
}

async function startMcpSession(
  req: IncomingMessage,
  res: ServerResponse,
  baseUrl: string,
  parsedBody: unknown,
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
    exposure: initialMcpToolExposure(requestedMcpToolExposure(req)),
    toolListDigest: '',
    binding: null,
    offline: null,
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
  await transport.handleRequest(req, res, parsedBody);
  if (!transport.sessionId) await server.close();
}


export function mcpSessionsForTest(): Array<{
  id: string;
  lastUsed: number;
  binding: EditorBinding | OfflineEditorBinding | null;
  bindingMode: 'browser' | 'offline' | null;
  staleReason: string | null;
  exposure: McpToolExposure;
}> {
  return [...sessions.entries()].map(([id, session]) => ({
    id,
    lastUsed: session.lastUsed,
    binding: session.binding ? { ...session.binding } : session.offline?.binding() ?? null,
    bindingMode: bindingMode(session),
    staleReason: session.staleReason,
    exposure: session.exposure,
  }));
}

export function setMcpSessionLastUsedForTest(id: string, lastUsed: number): void {
  const session = sessions.get(id);
  if (session) session.lastUsed = lastUsed;
}

export async function resetMcpSessionsForTest(): Promise<void> {
  const disposals = [...sessions.values()].flatMap((session) =>
    session.offline ? [session.offline.dispose()] : []);
  for (const id of [...sessions.keys()]) evictSession(id);
  await Promise.all(disposals);
}

export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  baseUrl: string,
): Promise<void> {
  let parsedBody: unknown;
  if (req.method === 'POST') {
    try {
      parsedBody = await readMcpPostBody(req);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid MCP request body';
      sendSessionError(res, /exceeds/.test(message) ? 413 : 400, message);
      return;
    }
  }
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
      forgetSession(session, 'cancelled', 'MCP transport session closed before the editor call completed.');
      await delayImmediate();
      await session.transport.handleRequest(req, res);
      return;
    }
    session.lastUsed = now;
    await session.transport.handleRequest(req, res, parsedBody);
    return;
  }
  if (req.method !== 'POST') {
    sendSessionError(res, 400, 'MCP session id is required');
    return;
  }
  await startMcpSession(req, res, baseUrl, parsedBody);
}
