import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import type { ClaudeCodeAgentModel, ClaudeCodeAgentModelsResponse } from '../../shared/claude-code-agent.ts';
import { claudeCodeCommand } from './command.ts';
import { childEnvironment } from './turn-runner.ts';

/**
 * The model list comes from the CLI itself. `claude -p --input-format
 * stream-json` answers an `initialize` control request with every model the
 * signed-in account can use, without starting a turn or spending tokens, so the
 * picker follows the CLI (new models, the account's default) instead of a list
 * that goes stale with every release.
 */

const MODELS_TIMEOUT_MS = 10_000;
const SUCCESS_TTL_MS = 10 * 60_000;
// Short, so a CLI that is mid-update or signed out recovers quickly, but long
// enough that a broken CLI is not respawned on every settings refresh.
const FAILURE_TTL_MS = 30_000;
const INITIALIZE_REQUEST_ID = 'openchatcut-models';

// Used when the CLI cannot be asked (missing, too old, timed out, unparseable).
// Canonical model ids, not the CLI's short aliases ("sonnet"/"opus"/"haiku"):
// the shared capability catalog is keyed by canonical id, and an alias misses
// every entry and falls through to the estimator, which reports a wrong context
// window and claims tools/images are unsupported.
export const FALLBACK_CLAUDE_CODE_MODELS: readonly ClaudeCodeAgentModel[] = [
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', isDefault: true },
  { id: 'claude-opus-5', label: 'Claude Opus 5', isDefault: false },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', isDefault: false },
];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Turns the `initialize` control_response into picker entries. Pure.
 *
 * - The id is `resolvedModel`, the canonical id the CLI runs ("opus" →
 *   "claude-opus-5-5"), for the same catalog reason as the fallback list.
 * - Aliases that resolve to the same model collapse into one entry; the first
 *   label wins, so "Opus 5.5" from the `opus` alias, not the `default` entry's
 *   "Default (recommended)".
 * - The `default` entry only says which model is the default: that model is
 *   marked and moved first, because the composer falls back to the first entry.
 *
 * Returns null when the response carries no usable model.
 */
export function parseClaudeCodeModels(response: unknown): ClaudeCodeAgentModel[] | null {
  const outer = record(record(response)?.response);
  if (outer?.subtype !== 'success') return null;
  const listed = record(outer.response)?.models;
  if (!Array.isArray(listed)) return null;

  let defaultId = '';
  let defaultHint = '';
  const labels = new Map<string, string>();
  for (const raw of listed) {
    const entry = record(raw);
    const id = text(entry?.resolvedModel);
    if (!entry || !id) continue;
    if (text(entry.value) === 'default') {
      defaultId ||= id;
      // "Opus 5.5 · Best for everyday, complex tasks" names the model when no
      // alias entry does.
      defaultHint ||= text(entry.description).split('·')[0]?.trim() ?? '';
      continue;
    }
    if (!labels.has(id)) labels.set(id, text(entry.displayName) || id);
  }
  if (defaultId && !labels.has(defaultId)) labels.set(defaultId, defaultHint || defaultId);
  if (labels.size === 0) return null;

  const ids = [...labels.keys()];
  const first = defaultId || ids[0];
  return [first, ...ids.filter((id) => id !== first)].map((id) => ({
    id,
    label: labels.get(id) ?? id,
    isDefault: id === first,
  }));
}

/** Asks one CLI process for its models. Rejects on timeout, exit or a bad answer. */
export async function requestClaudeCodeModels(
  claudePath: string,
  timeoutMs = MODELS_TIMEOUT_MS,
): Promise<ClaudeCodeAgentModel[]> {
  // Same sandbox flag as a turn: --restricted ignores the user's ~/.claude
  // settings and hooks, so the reported default is the model a turn without
  // --model actually runs, and no SessionStart hook fires for a model query.
  const command = claudeCodeCommand(claudePath, [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--restricted',
  ]);
  const child = spawn(command.executable, command.args, {
    env: childEnvironment(),
    // Not the app checkout: nothing there (CLAUDE.md, .mcp.json) is needed.
    cwd: tmpdir(),
    windowsHide: true,
    windowsVerbatimArguments: command.windowsVerbatimArguments,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const { promise, resolve, reject } = Promise.withResolvers<ClaudeCodeAgentModel[]>();
  const timer = setTimeout(() => reject(new Error('Claude Code model list timed out.')), timeoutMs);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return; }
    const message = record(parsed);
    if (message?.type !== 'control_response') return;
    if (record(message.response)?.request_id !== INITIALIZE_REQUEST_ID) return;
    const models = parseClaudeCodeModels(message);
    if (models) resolve(models);
    else reject(new Error('Claude Code returned no usable models.'));
  });
  child.once('error', reject);
  child.once('exit', (code) => reject(new Error(`Claude Code exited with code ${code ?? 'unknown'} before listing models.`)));
  child.stdin.on('error', () => {});
  child.stdin.write(`${JSON.stringify({
    type: 'control_request', request_id: INITIALIZE_REQUEST_ID, request: { subtype: 'initialize' },
  })}\n`);
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
    lines.close();
    // Closing stdin alone ends the CLI; the kill covers a CLI that hangs instead.
    child.stdin.end();
    if (child.exitCode === null) child.kill();
  }
}

interface CacheEntry {
  readonly expires: number;
  readonly models: readonly ClaudeCodeAgentModel[];
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<readonly ClaudeCodeAgentModel[]>>();

/**
 * The CLI's models, cached per CLI path and version (an upgrade asks again),
 * with concurrent callers sharing one process. Never rejects: any failure
 * answers with the fallback list, without an `error`, because the settings UI
 * treats `error` as "no models" and would empty the picker.
 */
export async function listClaudeCodeModels(
  claudePath: string,
  version: string | null,
  timeoutMs = MODELS_TIMEOUT_MS,
): Promise<ClaudeCodeAgentModelsResponse> {
  const key = `${claudePath}\n${version ?? ''}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return { models: cached.models };
  let pending = inflight.get(key);
  if (!pending) {
    pending = requestClaudeCodeModels(claudePath, timeoutMs).then(
      (models) => {
        cache.set(key, { expires: Date.now() + SUCCESS_TTL_MS, models });
        return models;
      },
      () => {
        cache.set(key, { expires: Date.now() + FAILURE_TTL_MS, models: FALLBACK_CLAUDE_CODE_MODELS });
        return FALLBACK_CLAUDE_CODE_MODELS;
      },
    ).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return { models: await pending };
}

/** Test hook: forget every cached answer. */
export function clearClaudeCodeModelCache(): void {
  cache.clear();
}
