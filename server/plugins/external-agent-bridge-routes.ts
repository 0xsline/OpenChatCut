import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  nextEditorCall,
  nextEditorCancellation,
  editorCallBinding,
  editorRegistrationMatches,
  registerEditor,
  settleEditorCall,
  touchEditor,
  unregisterEditor,
  ExternalCallTerminalOutcome,
  ExternalToolSchema,
} from '../external-agent/broker.ts';
import type { mcpTools } from '../external-agent/mcp.ts';
import {
  abortUploadReceipt,
  claimUploadReceipt,
  commitUploadReceipt,
  mintImportUpload,
} from '../external-agent/import-token.ts';
import type { claimBrowserProjectOwnership } from '../external-agent/project-edit-ownership.ts';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const REGISTRATION_CAPABILITY_HEADER = 'x-openchatcut-editor-registration';

function registrationCapability(req: IncomingMessage, required: boolean): string | null {
  const raw = req.headers[REGISTRATION_CAPABILITY_HEADER];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
  if (!value) {
    if (required) throw new Error('editor registration capability is required');
    return null;
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error('editor registration capability is invalid');
  }
  return value;
}

export interface BridgeOperations {
  claimBrowserOwnership: typeof claimBrowserProjectOwnership;
  editorRegistrationMatches: typeof editorRegistrationMatches;
  registerEditor: typeof registerEditor;
  unregisterEditor: typeof unregisterEditor;
  nextEditorCall: typeof nextEditorCall;
  nextEditorCancellation: typeof nextEditorCancellation;
  settleEditorCall: typeof settleEditorCall;
  editorCallBinding: typeof editorCallBinding;
  touchEditor: typeof touchEditor;
  mcpTools: typeof mcpTools;
}

export async function readBridgeJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8') || '{}';
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export function sendBridgeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function validTools(value: unknown): value is ExternalToolSchema[] {
  return Array.isArray(value) && value.every((tool) => (
    Boolean(tool)
    && typeof tool === 'object'
    && typeof tool.name === 'string'
    && Boolean(tool.input_schema)
    && typeof tool.input_schema === 'object'
    && tool.input_schema.type === 'object'
  ));
}

function validOutcome(value: unknown): value is ExternalCallTerminalOutcome {
  return value === 'applied'
    || value === 'rejected'
    || value === 'cancelled'
    || value === 'stale'
    || value === 'failed';
}

function registrationInput(body: Record<string, unknown>): {
  projectId: string;
  editorId: string;
  baseRevision: string;
  tools: ExternalToolSchema[];
} {
  if (
    typeof body.projectId !== 'string'
    || typeof body.editorId !== 'string'
    || typeof body.baseRevision !== 'string'
    || !body.projectId.trim()
    || !body.editorId.trim()
    || !body.baseRevision.trim()
    || !validTools(body.tools)
  ) throw new Error('invalid editor registration');
  return {
    projectId: body.projectId.trim(),
    editorId: body.editorId.trim(),
    baseRevision: body.baseRevision.trim(),
    tools: body.tools,
  };
}

async function registerBridgeEditor(
  req: IncomingMessage,
  res: ServerResponse,
  operations: BridgeOperations,
): Promise<void> {
  const input = registrationInput(await readBridgeJson(req));
  const capability = registrationCapability(req, false);
  // A matching registration capability marks a legitimate renewal from the
  // currently owned window (e.g. a page reload keeps its capability). A
  // missing/mismatched capability on a DIFFERENT window is no longer blocked —
  // that window simply takes over (single-window desktop has no cross-window
  // exclusivity). Stale-revision protection below still prevents clobbering.
  const renewing = capability !== null && operations.editorRegistrationMatches(
    input.projectId,
    input.editorId,
    capability,
  );
  const claimed = await operations.claimBrowserOwnership(
    input.projectId,
    input.editorId,
    input.baseRevision,
    renewing,
  );
  if (claimed.status === 'stale') {
    sendBridgeJson(res, 409, {
      error: 'project changed after the browser loaded it',
      currentRevision: claimed.currentRevision,
      reloadRequired: true,
    });
    return;
  }
  if (claimed.status !== 'claimed') {
    sendBridgeJson(res, 409, { error: 'project is already owned or its ownership record is invalid' });
    return;
  }
  const issuedCapability = operations.registerEditor(
    input.projectId,
    input.editorId,
    input.baseRevision,
    input.tools,
    claimed.claim,
    capability,
  );
  sendBridgeJson(res, 200, {
    ok: true,
    ownershipEpoch: claimed.claim.epoch,
    registrationCapability: issuedCapability,
  });
}

async function unregisterBridgeEditor(
  req: IncomingMessage,
  res: ServerResponse,
  operations: BridgeOperations,
): Promise<void> {
  const body = await readBridgeJson(req);
  if (
    typeof body.projectId !== 'string'
    || typeof body.editorId !== 'string'
    || !body.projectId.trim()
    || !body.editorId.trim()
  ) throw new Error('invalid editor unregistration');
  const removed = await operations.unregisterEditor(
    body.projectId.trim(),
    body.editorId.trim(),
    registrationCapability(req, true),
  );
  sendBridgeJson(res, removed ? 200 : 409, removed
    ? { ok: true }
    : { error: 'editor registration is stale or owned by another session' });
}

async function pollEditorCall(
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
  operations: BridgeOperations,
): Promise<void> {
  const projectId = url.searchParams.get('projectId') ?? '';
  const editorId = url.searchParams.get('editorId') ?? '';
  const baseRevision = url.searchParams.get('baseRevision') ?? '';
  if (!projectId || !editorId || !baseRevision) {
    throw new Error('projectId, editorId, and baseRevision are required');
  }
  const capability = registrationCapability(req, true);
  if (!operations.editorRegistrationMatches(projectId, editorId, capability)) {
    sendBridgeJson(res, 409, { error: 'editor registration is stale or owned by another session' });
    return;
  }
  const call = await operations.nextEditorCall(
    projectId,
    editorId,
    baseRevision,
    AbortSignal.timeout(26_000),
    capability,
  );
  if (!call) {
    res.statusCode = 204;
    res.end();
  } else sendBridgeJson(res, 200, call);
}

async function pollEditorCancellation(
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
  operations: BridgeOperations,
): Promise<void> {
  const projectId = url.searchParams.get('projectId') ?? '';
  const editorId = url.searchParams.get('editorId') ?? '';
  if (!projectId || !editorId) throw new Error('projectId and editorId are required');
  const capability = registrationCapability(req, true);
  if (!operations.editorRegistrationMatches(projectId, editorId, capability)) {
    sendBridgeJson(res, 409, { error: 'editor registration is stale or owned by another session' });
    return;
  }
  const cancellation = await operations.nextEditorCancellation(
    projectId,
    editorId,
    AbortSignal.timeout(26_000),
    capability,
  );
  if (!cancellation) {
    res.statusCode = 204;
    res.end();
  } else sendBridgeJson(res, 200, cancellation);
}

async function settleBridgeCall(
  req: IncomingMessage,
  res: ServerResponse,
  operations: BridgeOperations,
): Promise<void> {
  const body = await readBridgeJson(req);
  if (typeof body.id !== 'string') throw new Error('invalid tool result');
  const outcome = validOutcome(body.outcome)
    ? body.outcome
    : body.ok === true
      ? 'applied'
      : body.ok === false
        ? 'failed'
        : null;
  if (!outcome) throw new Error('invalid tool result outcome');
  const capability = registrationCapability(req, true);
  const binding = operations.editorCallBinding(body.id);
  const settled = operations.settleEditorCall(
    body.id,
    outcome,
    body.value,
    capability,
  );
  if (settled && binding && typeof body.baseRevision === 'string' && body.baseRevision) {
    // The editor just committed the tool's mutation; sync the registry to the
    // post-tool revision so a follow-up MCP session binds to the current
    // snapshot instead of being rejected as stale by the previous one.
    await operations.touchEditor(
      binding.projectId,
      binding.editorInstanceId,
      body.baseRevision,
      capability,
    ).catch(() => undefined);
  }
  sendBridgeJson(res, settled ? 200 : 404, settled
    ? { ok: true }
    : { error: 'editor call is unavailable' });
}

async function handleBridgeReceipt(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBridgeJson(req);
  if (body.action === 'claim') {
    const claimed = claimUploadReceipt(body.receipt, body.projectId, body.claimId);
    if (claimed.status !== 'accepted') {
      sendBridgeJson(res, 409, {
        error: claimed.status === 'claimed'
          ? 'upload receipt is already being finalized'
          : 'upload receipt is invalid, expired, consumed, or outside this project',
      });
      return;
    }
    sendBridgeJson(res, 200, {
      ...claimed.value,
      claimId: claimed.claimId,
      claimExpiresAt: claimed.claimExpiresAt,
    });
    return;
  }
  if (body.action === 'commit') {
    const committed = commitUploadReceipt(body.receipt, body.projectId, body.claimId);
    sendBridgeJson(res, committed ? 200 : 409, committed
      ? { ok: true, state: 'committed' }
      : { error: 'upload receipt claim is invalid, expired, or no longer current' });
    return;
  }
  if (body.action === 'abort') {
    const aborted = abortUploadReceipt(body.receipt, body.projectId, body.claimId);
    sendBridgeJson(res, aborted ? 200 : 409, aborted
      ? { ok: true, state: 'available' }
      : { error: 'upload receipt claim is invalid, expired, or no longer current' });
    return;
  }
  sendBridgeJson(res, 400, { error: 'upload receipt action must be claim, commit, or abort' });
}

export async function routeExternalAgentBridge(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  operations: BridgeOperations,
): Promise<void> {
  if (req.method === 'POST' && url.pathname === '/import-token') {
    sendBridgeJson(res, 201, mintImportUpload(await readBridgeJson(req)));
  } else if (req.method === 'POST' && url.pathname === '/upload-receipt') {
    await handleBridgeReceipt(req, res);
  } else if (req.method === 'POST' && url.pathname === '/register') {
    await registerBridgeEditor(req, res, operations);
  } else if (req.method === 'POST' && url.pathname === '/unregister') {
    await unregisterBridgeEditor(req, res, operations);
  } else if (req.method === 'GET' && url.pathname === '/poll') {
    await pollEditorCall(req, url, res, operations);
  } else if (req.method === 'GET' && url.pathname === '/cancellation') {
    await pollEditorCancellation(req, url, res, operations);
  } else if (req.method === 'POST' && url.pathname === '/result') {
    await settleBridgeCall(req, res, operations);
  } else if (req.method === 'GET' && url.pathname === '/tools') {
    sendBridgeJson(res, 200, { tools: operations.mcpTools() });
  } else {
    sendBridgeJson(res, 404, { error: 'not found' });
  }
}
