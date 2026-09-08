import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadInitialProjects, syncAgentBackends, type ProjectStartupSource } from './appShell';
import { getActiveAgentModelChoice } from '../agent/model-selection';
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

console.log('appShell.verify: project startup and optional-backend isolation passed');
