import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import {
  BUILTIN_APPROVAL_MODE_HEADER,
  BUILTIN_CLIENT_HEADER,
  builtinApprovalMode,
} from './builtin-approval-mode.ts';
import { claudeCodeMcpConfig } from '../claude-code/turn-runner.ts';

function request(headers: Record<string, string | string[]>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

const builtin = (mode: string): Record<string, string> => ({
  [BUILTIN_CLIENT_HEADER]: 'claude-code-builtin',
  [BUILTIN_APPROVAL_MODE_HEADER]: mode,
});

// The bug this guards: the composer's auto-apply (YOLO) toggle never reached
// the Claude Code backend's edit session, because approvalMode was whatever
// the model passed to begin_edit_session and an omitted argument normalizes to
// "manual" — so a YOLO run still raised a confirmation card per tool call.
assert.equal(builtinApprovalMode(request(builtin('auto'))), 'auto',
  'the built-in backend declaring auto-apply is honoured');
assert.equal(builtinApprovalMode(request(builtin('manual'))), 'manual',
  'the built-in backend can also pin a run to manual');

// Only the built-in backend may have its argument overridden. A third-party MCP
// client (Claude Desktop, Cursor, a hand-rolled driver) keeps full control of
// its own approvalMode even if it guesses the approval header.
assert.equal(builtinApprovalMode(request({ [BUILTIN_APPROVAL_MODE_HEADER]: 'auto' })), null,
  'the approval header alone never overrides a third-party client');
assert.equal(
  builtinApprovalMode(request({
    [BUILTIN_CLIENT_HEADER]: 'some-other-client',
    [BUILTIN_APPROVAL_MODE_HEADER]: 'auto',
  })),
  null,
  'a client claiming another name is not the built-in backend',
);

// Absent or unparseable values fall back to "leave it to the model", which is
// the behaviour every release before this change had.
assert.equal(builtinApprovalMode(request({})), null, 'no headers means no override');
assert.equal(builtinApprovalMode(request(builtin(''))), null, 'an empty mode is not an override');
assert.equal(builtinApprovalMode(request(builtin('yolo'))), null, 'an unknown mode is not an override');
assert.equal(builtinApprovalMode(request(builtin('AUTO'))), null, 'the mode match is exact');
assert.equal(
  builtinApprovalMode(request({
    [BUILTIN_CLIENT_HEADER]: ['claude-code-builtin', 'other'],
    [BUILTIN_APPROVAL_MODE_HEADER]: ['auto', 'manual'],
  })),
  'auto',
  'a repeated header reads its first value rather than throwing',
);

// The turn writes that header into its private --mcp-config, so assert the
// config the CLI actually receives rather than trusting the plumbing above.
function headersOf(config: Record<string, unknown>): Record<string, string> {
  const servers = config.mcpServers as Record<string, { headers: Record<string, string> }>;
  return servers['openchatcut-builtin'].headers;
}

const autoHeaders = headersOf(claudeCodeMcpConfig('http://127.0.0.1:5199/mcp', 'tok', 'auto'));
assert.equal(autoHeaders[BUILTIN_APPROVAL_MODE_HEADER], 'auto',
  'an auto-apply run declares the mode to its own MCP server');
assert.equal(autoHeaders[BUILTIN_CLIENT_HEADER], 'claude-code-builtin',
  'the client header still identifies the built-in backend');
assert.equal(autoHeaders.Authorization, 'Bearer tok', 'the bearer token is unchanged');

assert.equal(
  headersOf(claudeCodeMcpConfig('http://127.0.0.1:5199/mcp', 'tok', 'manual'))[BUILTIN_APPROVAL_MODE_HEADER],
  'manual',
  'a manual run pins the mode too, rather than leaving it to the model',
);

// A request with no approvalMode must produce the byte-identical config every
// release before this change produced — the header is absent, not empty.
const legacy = headersOf(claudeCodeMcpConfig('http://127.0.0.1:5199/mcp', 'tok'));
assert.equal(BUILTIN_APPROVAL_MODE_HEADER in legacy, false,
  'a run that declares no mode sends no approval header at all');
assert.deepEqual(Object.keys(legacy), ['Authorization', 'x-openchatcut-mcp-client'],
  'the unset case keeps the original header set exactly');

// Round-trip: what the turn writes is what the server reads back.
assert.equal(builtinApprovalMode(request(autoHeaders)), 'auto',
  'the config the CLI receives round-trips to the mode the server enforces');
assert.equal(builtinApprovalMode(request(legacy)), null,
  'a run without a declared mode leaves begin_edit_session to the model, as before');

console.log('builtin-approval-mode.verify: built-in auto-apply override and third-party isolation passed');
