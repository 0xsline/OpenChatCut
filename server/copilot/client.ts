import { homedir } from 'node:os';
import { join } from 'node:path';
import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk';
import type { CopilotAccountSummary, CopilotAgentModel } from '../../shared/copilot-agent.ts';
import { resolveCopilotCli } from './installation.ts';

/**
 * Isolated Copilot home, mirroring `CODEX_HOME = ~/.openchatcut/codex`. Keeps
 * OpenChatCut's session state, config and logs out of the user's own
 * `~/.copilot` so an in-app run can never disturb their terminal CLI.
 */
const COPILOT_HOME = join(homedir(), '.openchatcut', 'copilot');
const MODEL_LIST_TIMEOUT_MS = 15_000;
const MODEL_CACHE_TTL_MS = 5 * 60_000;

/**
 * Environment allowlist for the spawned runtime. Same rationale as the Codex
 * integration: pass through only what the CLI genuinely needs so unrelated
 * secrets in the parent environment never reach the child.
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
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'GH_HOST', 'COPILOT_GH_HOST',
  'NO_COLOR', 'FORCE_COLOR',
] as const;

export class CopilotProcessError extends Error {
  constructor(message = 'Copilot CLI is unavailable.') {
    super(message);
    this.name = 'CopilotProcessError';
  }
}

function childEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of CHILD_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

let started: Promise<CopilotClient> | null = null;

/**
 * Lazily start a single shared runtime. The SDK multiplexes sessions over one
 * process, so unlike the Codex client there is no need to respawn per turn.
 */
export function copilotClient(): Promise<CopilotClient> {
  started ??= (async () => {
    const path = await resolveCopilotCli();
    if (!path) {
      throw new CopilotProcessError(
        'Copilot CLI not found. Install it (`brew install copilot` or `npm i -g @github/copilot`) '
        + 'or set OPENCHATCUT_COPILOT_PATH.',
      );
    }
    const client = new CopilotClient({
      connection: RuntimeConnection.forStdio({ path, env: childEnvironment() }),
      baseDirectory: COPILOT_HOME,
      logLevel: 'error',
    });
    try {
      await client.start();
    } catch (error) {
      started = null;
      throw new CopilotProcessError(
        error instanceof Error ? error.message : 'Copilot CLI failed to start.',
      );
    }
    return client;
  })();
  return started;
}

export async function stopCopilotClient(): Promise<void> {
  const pending = started;
  started = null;
  if (!pending) return;
  await pending.then((client) => client.stop()).catch(() => undefined);
}

export async function readCopilotAuth(): Promise<CopilotAccountSummary & { authenticated: boolean }> {
  const client = await copilotClient();
  const status = await client.getAuthStatus();
  return {
    authenticated: status.isAuthenticated === true,
    login: status.login ?? null,
    authType: status.authType ?? null,
    host: status.host ?? null,
  };
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Project the SDK model catalog onto OpenChatCut's model-picker shape. The
 * limits map straight onto `ModelCapabilities` (contextWindowTokens /
 * maxOutputTokens), which is what the `api` and `codex` backends already feed.
 */
export async function listCopilotModels(): Promise<readonly CopilotAgentModel[]> {
  const client = await copilotClient();
  const raw = await Promise.race([
    client.listModels(),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new CopilotProcessError('Copilot model list timed out.')), MODEL_LIST_TIMEOUT_MS);
    }),
  ]);
  const models = raw
    .filter((model) => model.id !== 'auto')
    .map((model) => {
      const entry = model as unknown as Record<string, any>;
      const capabilities = entry.capabilities ?? {};
      const supports = capabilities.supports ?? {};
      const limits = capabilities.limits ?? {};
      return {
        id: String(entry.id),
        label: String(entry.name ?? entry.id),
        isDefault: entry.isDefault === true,
        supportsTools: supports.tool_calls === true,
        supportsVision: supports.vision === true,
        contextWindowTokens: numeric(limits.max_context_window_tokens)
          ?? numeric(limits.max_prompt_tokens),
        maxInputTokens: numeric(limits.max_prompt_tokens),
        maxOutputTokens: numeric(limits.max_output_tokens),
        supportedReasoningEfforts: Array.isArray(entry.supportedReasoningEfforts)
          ? entry.supportedReasoningEfforts.map(String)
          : [],
      } satisfies CopilotAgentModel;
    });
  cache = { models, at: Date.now() };
  return models;
}

let cache: { models: readonly CopilotAgentModel[]; at: number } | null = null;

/**
 * Copilot reports authoritative per-model limits, but server runs only carry a
 * model id. Cache the catalog so `createExecutionPlan` can resolve real context
 * windows instead of falling back to the bundled models.dev estimates.
 */
export async function copilotModelFacts(modelId: string): Promise<CopilotAgentModel | null> {
  if (!modelId) return null;
  const fresh = cache && Date.now() - cache.at < MODEL_CACHE_TTL_MS ? cache.models : null;
  const models = fresh ?? await listCopilotModels().catch(() => cache?.models ?? []);
  return models.find((model) => model.id === modelId) ?? null;
}