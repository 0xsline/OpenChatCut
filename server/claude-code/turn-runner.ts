import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ClaudeCodeTurnRequest, ClaudeCodeTurnStreamEvent } from '../../shared/claude-code-agent.ts';
import { claudeCodeCommand } from './command.ts';

/**
 * Unlike Codex's app-server (a long-lived JSON-RPC process with a
 * dynamicTools bridge OpenChatCut must execute against), Claude Code CLI's
 * own MCP client calls OpenChatCut's MCP server directly and executes tools
 * itself. Each turn is a fresh `claude -p ... --output-format stream-json`
 * subprocess; OpenChatCut only needs to spawn it, feed it an MCP config
 * pointing back at its own external-mcp endpoint, and translate the NDJSON
 * output for display. No tool-result settlement RPC exists or is needed.
 */

const CHILD_ENV_NAMES = [
  'PATH', 'Path', 'PATHEXT',
  'HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'USERNAME',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'SystemRoot', 'WINDIR', 'COMSPEC', 'ComSpec',
  'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY',
  'NO_COLOR', 'FORCE_COLOR',
] as const;

// Deliberately NOT plain "openchatcut": Claude Code caches MCP auth failures by
// SERVER NAME, not by URL, in ~/.claude/mcp-needs-auth-cache.json. Users commonly
// register their own "openchatcut" server (the repo ships one in .mcp.json, and
// `claude mcp add openchatcut ...` is the documented setup). If any of those ever
// fails to authorize once, the CLI caches "openchatcut needs auth" and then routes
// EVERY server of that name — including this turn's private, correctly
// bearer-authenticated --mcp-config — into the OAuth path, exposing only
// authenticate/complete_authentication and hiding all editor tools. --strict-mcp-config
// does not help, because the collision is on the name rather than the config source.
// Keeping a private name makes this turn's server independent of the user's own.
const MCP_SERVER_NAME = 'openchatcut-builtin';
const ALLOWED_TOOLS = `mcp__${MCP_SERVER_NAME}__*`;
const RUNTIME_RULES = [
  'You are the built-in Agent inside the OpenChatCut video editor, driving the currently open project',
  `through the "${MCP_SERVER_NAME}" MCP server. Prefer the ${ALLOWED_TOOLS} tools over any general-purpose`,
  'reasoning about files — those tools are the only supported way to read or change the project.',
  'Call begin_edit_session before editing, keep its editSessionId for every editor tool call, and',
  'finish with review_edit_session. Do not claim an edit succeeded before that returns applied.',
  // Session setup is the failure mode this backend actually hits: the editor
  // re-registers whenever its page reconnects (dev-server HMR is enough), which
  // invalidates the binding mid-turn. Without these rules the model reads each
  // stale-binding error as "setup did not happen" and restarts it — observed
  // burning a whole turn on 7x target_project + 7x begin_edit_session and never
  // reaching an actual edit.
  'Session setup is once per turn: call target_project at most once, then begin_edit_session at most',
  'once. If begin_edit_session reports a session is already active, reuse that session — do not open',
  'another. If a call fails with a stale or invalidated binding, call target_project exactly once more',
  'to rebind, then continue from where you stopped; never restart the whole setup sequence. If it is',
  'still stale after that single retry, stop and report the binding problem instead of retrying again.',
  // An edit session left in `drafting` blocks the project for EVERY later client,
  // and a session can only be discarded by the transport that owns it — so an
  // abandoned one cannot be cleaned up afterwards by anyone and has to be
  // deleted from the project store by hand. Observed in practice: a manual-mode
  // session with operationCount 0 wedged the project until it was removed from
  // disk. Whatever happens, the session this turn opens must reach a terminal
  // state before the turn ends.
  'Never end a turn with an edit session still open. Every session you begin must terminate: call',
  'review_edit_session when the edit is ready, or discard_edit_session if you are abandoning the',
  'work, erroring out, or stopping for any other reason. An abandoned drafting session blocks the',
  'project for every future client and can only be discarded by the session that created it, so',
  'leaving one open is never recoverable — discard it before you report a failure.',
  // Live-project tools (import_media, finalize_uploaded_asset, download_media,
  // auto_grade, render/export) mutate stored project state, and a stored-project
  // change invalidates any open draft by design. Sequencing them first avoids
  // losing draft work to a stale binding.
  'Run live-project tools (import_media, finalize_uploaded_asset, download_media, render and export)',
  'BEFORE you call begin_edit_session: they change stored project state, which deliberately',
  'invalidates any draft that is already open.',
].join(' ');

export class ClaudeCodeProcessError extends Error {
  constructor(message = 'Claude Code CLI is unavailable.') {
    super(message);
    this.name = 'ClaudeCodeProcessError';
  }
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of CHILD_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

interface PendingToolUse {
  readonly name: string;
  readonly args: unknown;
}

/** Translates one parsed stream-json line into zero or more display events. Exported for verify tests. */
export function translateClaudeCodeLine(
  line: Record<string, unknown>,
  pendingTools: Map<string, PendingToolUse>,
): ClaudeCodeTurnStreamEvent[] {
  const events: ClaudeCodeTurnStreamEvent[] = [];
  const type = line.type;
  if (type === 'system' && line.subtype === 'init') {
    const sessionId = line.session_id;
    if (typeof sessionId === 'string' && sessionId) events.push({ type: 'session', sessionId });
    return events;
  }
  if (type === 'assistant') {
    const message = record(line.message);
    for (const block of array(message?.content)) {
      const b = record(block);
      if (!b) continue;
      if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) {
        events.push({ type: 'thinking-delta', delta: b.thinking });
      } else if (b.type === 'text' && typeof b.text === 'string' && b.text) {
        events.push({ type: 'text-delta', delta: b.text });
      } else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        pendingTools.set(b.id, { name: b.name, args: b.input });
        events.push({ type: 'tool-start', callId: b.id, name: b.name, args: b.input });
      }
    }
    return events;
  }
  if (type === 'user') {
    const message = record(line.message);
    for (const block of array(message?.content)) {
      const b = record(block);
      if (!b || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
      const pending = pendingTools.get(b.tool_use_id);
      pendingTools.delete(b.tool_use_id);
      events.push({
        type: 'tool-end',
        callId: b.tool_use_id,
        name: pending?.name ?? 'unknown',
        args: pending?.args ?? null,
        result: b.content,
        success: b.is_error !== true,
      });
    }
    return events;
  }
  if (type === 'result') {
    const usage = record(line.modelUsage);
    const modelKey = usage ? Object.keys(usage)[0] : undefined;
    const modelUsage = modelKey ? record(usage![modelKey]) : null;
    if (modelUsage) {
      events.push({
        type: 'context-usage',
        inputTokens: typeof modelUsage.inputTokens === 'number' ? modelUsage.inputTokens : 0,
        contextWindowTokens: typeof modelUsage.contextWindow === 'number' ? modelUsage.contextWindow : undefined,
        outputTokens: typeof modelUsage.outputTokens === 'number' ? modelUsage.outputTokens : undefined,
        cacheReadTokens: typeof modelUsage.cacheReadInputTokens === 'number'
          ? modelUsage.cacheReadInputTokens : undefined,
      });
    }
    if (line.is_error === true || line.subtype !== 'success') {
      const message = typeof line.result === 'string' && line.result
        ? line.result
        : 'Claude Code turn failed.';
      events.push({ type: 'error', message });
    }
    events.push({ type: 'done' });
    return events;
  }
  return events;
}

async function withTempMcpConfig<T>(
  mcpUrl: string,
  mcpToken: string,
  run: (path: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'occ-claude-code-'));
  const path = join(dir, `mcp-${randomUUID()}.json`);
  const config = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'http',
        url: mcpUrl,
        headers: {
          Authorization: `Bearer ${mcpToken}`,
          'x-openchatcut-mcp-client': 'claude-code-builtin',
        },
      },
    },
  };
  await writeFile(path, JSON.stringify(config), 'utf8');
  try {
    return await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Runs one `claude -p` turn as a fresh subprocess, streaming translated
 * display events. Tool execution happens inside the CLI itself via the MCP
 * server it's given — OpenChatCut never intercepts or settles tool calls.
 */
export async function runClaudeCodeTurn(
  claudePath: string,
  request: ClaudeCodeTurnRequest,
  mcpUrl: string,
  mcpToken: string,
  emit: (event: ClaudeCodeTurnStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  await withTempMcpConfig(mcpUrl, mcpToken, async (mcpConfigPath) => {
    const systemPrompt = request.system ? `${RUNTIME_RULES}\n\n${request.system}` : RUNTIME_RULES;
    // The system prompt goes in a file, never on the command line. OpenChatCut's
    // agent system prompt runs to tens of KB, and Windows caps a command line at
    // ~32 KB total: passing it inline as --append-system-prompt overflows that
    // and spawn fails with ENAMETOOLONG. --append-system-prompt-file is verified
    // equivalent (same behavior as the inline flag). It lives in the same temp
    // dir as the MCP config so the existing cleanup removes both.
    const systemPromptPath = join(dirname(mcpConfigPath), `system-${randomUUID()}.txt`);
    await writeFile(systemPromptPath, systemPrompt, 'utf8');
    const args = [
      '-p', request.prompt,
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--mcp-config', mcpConfigPath,
      '--strict-mcp-config',
      '--allowedTools', ALLOWED_TOOLS,
      '--permission-mode', 'bypassPermissions',
      '--append-system-prompt-file', systemPromptPath,
    ];
    if (request.model) args.push('--model', request.model);
    if (request.sessionId) args.push('--resume', request.sessionId);
    const command = claudeCodeCommand(claudePath, args);
    const child = spawn(command.executable, command.args, {
      env: childEnvironment(),
      windowsHide: true,
      windowsVerbatimArguments: command.windowsVerbatimArguments,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pendingTools = new Map<string, PendingToolUse>();
    let sawResult = false;
    let stderrTail = '';
    const onAbort = () => { child.kill(); };
    signal.addEventListener('abort', onAbort, { once: true });
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
    });
    try {
      for await (const rawLine of rl) {
        const line = rawLine.trim();
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const record_ = record(parsed);
        if (!record_) continue;
        if (record_.type === 'result') sawResult = true;
        for (const event of translateClaudeCodeLine(record_, pendingTools)) emit(event);
      }
      const { promise, resolve } = Promise.withResolvers<number | null>();
      child.once('exit', (code) => resolve(code));
      const exitCode = await promise;
      if (!sawResult) {
        if (signal.aborted) {
          // Aborted before completion — no terminal event needed, the caller already knows.
        } else {
          const message = stderrTail.trim() || `Claude Code CLI exited with code ${exitCode ?? 'unknown'}.`;
          emit({ type: 'error', message });
          emit({ type: 'done' });
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      rl.close();
      if (!child.killed) child.kill();
    }
  });
}
