import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { createMiniConnect } from '../../desktop/mini-connect';

// A dedicated editor process: neither dotenv nor a real user keystore is read.
os.homedir = () => process.env.TEST_CONTINUATION_PROFILE!;
syncBuiltinESMExports();
const { KEY_NAMES, seedKeystore } = await import('../keystore');
seedKeystore({ ...Object.fromEntries(KEY_NAMES.map(name => [name, ''])),
  LLM_PROVIDER: 'openai', LLM_OPENAI_API_KEY: 'continuation-fixture-key',
  LLM_OPENAI_BASE_URL: process.env.TEST_PROVIDER_ORIGIN + '/v1',
  LLM_OPENAI_API_MODE: 'chat', LLM_OPENAI_MODEL: 'gpt-4.1',
});
const { agentRunsPlugin } = await import('./routes');
const { llmProxyPlugin } = await import('../plugins/llm-proxy');
const { loadAgentRuntimeSidecar, loadAgentArtifact } = await import('../../src/persist/agentRuntimeStore');
const { runRecoveryStore } = await import('./run-recovery-store');
const { getRun } = await import('./store');
const app = createMiniConnect(error => { throw error; });
for (const plugin of [llmProxyPlugin(), agentRunsPlugin()]) {
  const configure = plugin.configureServer;
  assert.equal(typeof configure, 'function');
  if (typeof configure === 'function') configure({ middlewares: app } as never);
}
const server = createServer((req, res) => {
  // This read-only endpoint exists only in the test process and exposes the
  // persisted evidence needed to assert that pause keeps drafts and input.
  if (req.url?.startsWith('/fixture/evidence?')) {
    void (async () => {
      const query = new URL(req.url!, 'http://127.0.0.1').searchParams;
      const projectId = query.get('projectId')!;
      const runId = query.get('runId')!;
      const sidecar = await loadAgentRuntimeSidecar(projectId);
      const run = sidecar.runs.find(item => item.runId === runId)!;
      const recovery = runRecoveryStore().load({ projectId, runId, sessionGeneration: sidecar.sessionGeneration });
      const artifact = await loadAgentArtifact(projectId, query.get('artifactId')!);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ recovery, artifact, sidecarRun: run, events: getRun(runId)?.events ?? [] }));
    })().catch(error => { res.writeHead(500); res.end(String(error)); });
    return;
  }
  app.handle(req, res);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address === 'object');
process.send!(address.port);
