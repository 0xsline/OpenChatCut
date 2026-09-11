import type { IncomingMessage } from 'node:http';
import type { ExternalApprovalMode } from '../../src/agent/external-edit-session.ts';

/**
 * The built-in Claude Code backend reaches this MCP server as an ordinary
 * external client, so the composer's auto-apply (YOLO) toggle cannot reach the
 * edit session the way it does on the in-process API/Codex paths: the session's
 * approvalMode is whatever the model happens to pass to begin_edit_session, and
 * an omitted argument normalizes to "manual". The result was a YOLO run that
 * still raised a confirmation card for every real-project tool call.
 *
 * The turn's private --mcp-config therefore states the mode as a header, and
 * the server overrides begin_edit_session's argument with it. Enforcing here
 * rather than instructing the model keeps the mode a fact about the run instead
 * of something a turn can forget to pass.
 *
 * Both headers are required. The client header alone identifies the built-in
 * backend; no third-party MCP client (Claude Desktop, Cursor, a hand-rolled
 * driver) can have its approvalMode overridden by this path.
 */
const BUILTIN_CLIENT = 'claude-code-builtin';
export const BUILTIN_CLIENT_HEADER = 'x-openchatcut-mcp-client';
export const BUILTIN_APPROVAL_MODE_HEADER = 'x-openchatcut-approval-mode';

function headerValue(req: IncomingMessage, name: string): string {
  const raw = req.headers[name];
  return (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
}

/**
 * The approval mode the built-in backend declared for this MCP session, or
 * null for every other client. Read once at session start: each turn is a
 * fresh `claude -p` subprocess and therefore a fresh MCP session, so the
 * toggle's value is always the one that was live when the turn began.
 */
export function builtinApprovalMode(req: IncomingMessage): ExternalApprovalMode | null {
  if (headerValue(req, BUILTIN_CLIENT_HEADER) !== BUILTIN_CLIENT) return null;
  const mode = headerValue(req, BUILTIN_APPROVAL_MODE_HEADER);
  return mode === 'auto' || mode === 'manual' ? mode : null;
}
