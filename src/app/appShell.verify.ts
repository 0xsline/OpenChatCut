import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadInitialProjects, syncAgentBackends, type ProjectStartupSource } from './appShell';
import { getActiveAgentModelChoice, getAgentModelSnapshot, subscribeAgentModels } from '../agent/model-selection';
import type { ProjectMeta } from '../persist/projectStoreCoordinators';
import { syncDesktopNativeInferenceEnabled } from '../transcript/desktop-inference-preference';

const demo = { id: 'demo', name: '示例工程', updatedAt: 1 };

function source(options: {
  projects?: ProjectMeta[];
  hasHistory?: boolean;
  canSeedDemo: boolean;
  onCreate?: () => void;
}): ProjectStartupSource {
  return {
    list: async () => options.projects ?? [],
    hasHistory: async () => options.hasHistory ?? false,
    canSeedDemo: () => options.canSeedDemo,
    createDemo: async () => {
      options.onCreate?.();
      return demo;
    },
  };
}

let readOnlyCreates = 0;
const readOnlyProjects = await loadInitialProjects(source({
  canSeedDemo: false,
  onCreate: () => { readOnlyCreates += 1; },
}));
assert.deepEqual(readOnlyProjects, [], 'sessionless empty remote listing resolves to an empty terminal state');
assert.equal(readOnlyCreates, 0, 'read-only startup never attempts the rejected demo write');

for (const mode of ['authorized remote', 'local/offline']) {
  let creates = 0;
  const projects = await loadInitialProjects(source({
    canSeedDemo: true,
    onCreate: () => { creates += 1; },
  }));
  assert.deepEqual(projects, [demo], `${mode} first-run still seeds the demo`);
  assert.equal(creates, 1, `${mode} first-run creates exactly one demo`);
}

let historyCreates = 0;
assert.deepEqual(
  await loadInitialProjects(source({
    hasHistory: true,
    canSeedDemo: true,
    onCreate: () => { historyCreates += 1; },
  })),
  [],
  'an intentionally emptied project history stays empty',
);
assert.equal(historyCreates, 0, 'project history still suppresses demo recreation');

const existing = [{ id: 'existing', name: 'Existing', updatedAt: 2 }];
assert.deepEqual(
  await loadInitialProjects(source({ projects: existing, canSeedDemo: false })),
  existing,
  'existing projects remain readable without write authority',
);

const appSource = await readFile(new URL('../App.tsx', import.meta.url), 'utf8');
assert.match(appSource, /useInferenceWarmup\(route\.name === 'editor'\)/, 'App wires unified inference warmup only while editing');
assert.doesNotMatch(appSource, /useLocalAsrWarmup/, 'App no longer wires the ASR-only warmup path');

const descriptors = {
  window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
  localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
};
const applied: boolean[] = [];
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: () => '1', setItem: () => undefined },
});
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { openChatCutDesktop: { inference: { setEnabled: async (enabled: boolean) => { applied.push(enabled); } } } },
});
try {
  assert.equal(await syncDesktopNativeInferenceEnabled(), true, 'restart reads the persisted native inference preference');
  assert.deepEqual(applied, [true], 'restart sync applies the preference to the desktop bridge');
} finally {
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
}

const originalFetch = globalThis.fetch;
const pendingCopilot = Promise.withResolvers<Response>();
const requestedPaths: string[] = [];
let copilotSaved = '';
let startupTimeout: ReturnType<typeof setTimeout> | undefined;
try {
  globalThis.fetch = async (input) => {
    const path = String(input);
    requestedPaths.push(path);
    if (path === '/api/copilot/status') return pendingCopilot.promise;
    if (path.startsWith('/api/claude-code/')) return Response.json({ installed: false, version: null, account: null });
    return Response.json(path === '/api/codex/status' ? { installed: false } : {
      keys: { LLM_OPENAI_API_KEY: { configured: true } },
      models: { LLM_PROVIDER: 'openai', LLM_OPENAI_MODEL: 'gpt-5.5', COPILOT_MODEL: copilotSaved },
    });
  };
  await syncAgentBackends(() => true);
  assert.equal(requestedPaths.includes('/api/copilot/status'), false,
    'an unconfigured optional backend must not start on app launch');
  copilotSaved = 'auto';
  await Promise.race([
    syncAgentBackends(() => true),
    new Promise<never>((_, reject) => {
      startupTimeout = setTimeout(() => reject(new Error('API startup waited for Copilot')), 500);
    }),
  ]);
  assert.equal(requestedPaths.includes('/api/copilot/status'), true);
  assert.equal(getActiveAgentModelChoice()?.backend, 'api',
    'configured API models are usable while a Copilot status request remains unresolved');
} finally {
  clearTimeout(startupTimeout);
  pendingCopilot.resolve(Response.json({ installed: false }));
  globalThis.fetch = originalFetch;
}

// Claude Code is discovered on app launch, not on the first Settings mount.
// Regression guard: the Anthropic entries used to reach the model picker only
// after the user opened Settings and re-detected the CLI by hand, because
// useClaudeCodeSettings was the sole caller of applyClaudeCodeAgentStatus.
function awaitClaudeCodeChoice(timeoutMs = 1_000): Promise<boolean> {
  const claudeCodeReady = (): boolean =>
    getAgentModelSnapshot().choices.some((choice) => choice.backend === 'claude-code');
  if (claudeCodeReady()) return Promise.resolve(true);
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => { unsubscribe(); resolve(false); }, timeoutMs);
  const unsubscribe = subscribeAgentModels(() => {
    if (!claudeCodeReady()) return;
    clearTimeout(timer);
    unsubscribe();
    resolve(true);
  });
  return promise;
}

const startupFetch = globalThis.fetch;
const claudeCodePaths: string[] = [];
try {
  globalThis.fetch = async (input) => {
    const path = String(input);
    claudeCodePaths.push(path);
    if (path === '/api/claude-code/status') {
      return Response.json({
        installed: true,
        version: '2.1.260',
        account: { loggedIn: true, email: 'user@example.com', subscriptionType: 'max', authMethod: 'oauth' },
      });
    }
    if (path === '/api/claude-code/models') {
      return Response.json({ models: [{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5', isDefault: true }] });
    }
    if (path === '/api/codex/status') return Response.json({ installed: false });
    return Response.json({ keys: {}, models: { LLM_PROVIDER: 'openai' } });
  };
  await syncAgentBackends(() => true);
  assert.equal(claudeCodePaths.includes('/api/claude-code/status'), true,
    'app launch probes the Claude Code CLI without waiting for Settings to mount');
  assert.equal(await awaitClaudeCodeChoice(), true,
    'a signed-in Claude Code CLI reaches the model picker on launch');
  const claudeCode = getAgentModelSnapshot().choices.find((choice) => choice.backend === 'claude-code');
  assert.equal(claudeCode?.provider, 'anthropic', 'the launch-discovered entry is the Anthropic provider');
  assert.equal(claudeCode?.model, 'claude-sonnet-5', 'discovered model ids reach the picker verbatim');
  assert.equal(claudeCodePaths.includes('/api/claude-code/models'), true,
    'a signed-in account has its models listed without a manual "read models" click');
} finally {
  globalThis.fetch = startupFetch;
}

console.log('appShell.verify: project startup and optional-backend isolation passed');
