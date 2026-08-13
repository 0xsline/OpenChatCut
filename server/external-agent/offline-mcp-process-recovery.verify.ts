import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version.ts';
import type { ProjectDoc } from '../../src/editor/types.ts';

const RESULT_PREFIX = 'ISSUE63_RESULT=';
const projectId = 'issue63-process-recovery';

interface WorkerResult {
  begin: Record<string, unknown>;
  read?: Record<string, unknown>;
}

function projectDoc(): ProjectDoc {
  return {
    version: CURRENT_PROJECT_VERSION,
    assets: [],
    mediaFolders: [],
    activeTimelineId: 'timeline-1',
    timelines: [{
      id: 'timeline-1',
      name: 'Timeline 1',
      order: 0,
      fps: 30,
      width: 1920,
      height: 1080,
      items: [],
      selectedId: null,
      trackOrder: ['track-v1'],
      tracks: { 'track-v1': { kind: 'video' } },
    }],
  };
}

function content(result: CallToolResult): Record<string, unknown> {
  assert(result.structuredContent);
  return result.structuredContent;
}

function editSessionId(result: CallToolResult): string {
  const value = content(result).editSessionId;
  assert.equal(typeof value, 'string');
  return value;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return address.port;
}

async function createHarness(): Promise<{
  client: Client;
  server: Server;
  reset(): Promise<void>;
}> {
  const { resetExternalAgentBrokerForTest } = await import('./broker.ts');
  const { handleMcpRequest, resetMcpSessionsForTest } = await import('./mcp.ts');
  const server = createServer((req, res) => {
    void handleMcpRequest(req, res, 'http://127.0.0.1').catch((error) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  const port = await listen(server);
  const client = new Client({ name: 'issue63-process-recovery', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
  ));
  return {
    client,
    server,
    async reset() {
      await resetMcpSessionsForTest();
      resetExternalAgentBrokerForTest();
    },
  };
}

async function targetAndBegin(client: Client): Promise<CallToolResult> {
  const target = await client.callTool({
    name: 'target_project',
    arguments: { projectId },
  });
  assert.notEqual(target.isError, true, JSON.stringify(target.structuredContent));
  assert.equal(content(target).bindingMode, 'offline');
  return client.callTool({
    name: 'begin_edit_session',
    arguments: { approvalMode: 'auto' },
  });
}

async function writeResult(result: WorkerResult): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function seedWorker(): Promise<void> {
  const { setStoredEntry } = await import('../plugins/project-store.ts');
  await setStoredEntry(`project:${projectId}`, projectDoc());
  await setStoredEntry('projects', [{ id: projectId, name: 'Issue 63', updatedAt: 1 }]);
  const harness = await createHarness();
  try {
    const begin = await targetAndBegin(harness.client);
    assert.notEqual(begin.isError, true, JSON.stringify(begin.structuredContent));
    assert.equal(content(begin).resumed, false);
    const edit = await harness.client.callTool({
      name: 'set_aspect_ratio',
      arguments: { editSessionId: editSessionId(begin), ratio: '9:16' },
    });
    assert.notEqual(edit.isError, true, JSON.stringify(edit.structuredContent));
    await writeResult({ begin: content(begin) });
  } finally {
    await harness.reset();
    await harness.client.close().catch(() => undefined);
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
  }
}

async function resumeWorker(): Promise<void> {
  const harness = await createHarness();
  try {
    const begin = await targetAndBegin(harness.client);
    assert.notEqual(begin.isError, true, JSON.stringify(begin.structuredContent));
    assert.equal(content(begin).resumed, true);
    const read = await harness.client.callTool({
      name: 'read_project',
      arguments: { editSessionId: editSessionId(begin) },
    });
    assert.notEqual(read.isError, true, JSON.stringify(read.structuredContent));
    assert.equal(content(read).ok, true);
    await writeResult({ begin: content(begin), read: content(read) });
  } finally {
    await harness.reset();
    await harness.client.close().catch(() => undefined);
    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
  }
}

function resultFromOutput(output: string): WorkerResult {
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith(RESULT_PREFIX));
  assert(line, `worker emitted no result:\n${output}`);
  return JSON.parse(line.slice(RESULT_PREFIX.length)) as WorkerResult;
}

async function runWorker(
  mode: 'seed' | 'resume',
  home: string,
  artifactRoot: string,
): Promise<WorkerResult> {
  const args = ['--import=tsx', fileURLToPath(import.meta.url), '--worker', mode];
  const child = spawn(process.execPath, args, {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  await writeFile(join(artifactRoot, `${mode}.stdout.log`), stdout);
  await writeFile(join(artifactRoot, `${mode}.stderr.log`), stderr);
  assert.equal(code, 0, `${mode} worker exited ${code}:\n${stderr}\n${stdout}`);
  return resultFromOutput(stdout);
}

async function parent(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'openchatcut-issue63-'));
  const home = join(root, 'home');
  const keep = process.env.ISSUE63_KEEP_TEMP === '1';
  try {
    const seed = await runWorker('seed', home, root);
    const resumed = await runWorker('resume', home, root);
    assert.equal(seed.begin.resumed, false);
    assert.equal(resumed.begin.resumed, true);
    assert.equal(resumed.begin.editSessionId, seed.begin.editSessionId);
    assert.equal(resumed.read?.ok, true);
    console.log('offline MCP process recovery check passed (resumed checkpoint, first read_project)');
  } finally {
    if (keep) console.log(`Issue #63 diagnostics: ${root}`);
    else await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}

const workerIndex = process.argv.indexOf('--worker');
if (workerIndex >= 0) {
  const mode = process.argv[workerIndex + 1];
  if (mode === 'seed') await seedWorker();
  if (mode === 'resume') await resumeWorker();
  if (mode !== 'seed' && mode !== 'resume') throw new Error(`unknown worker mode: ${mode}`);
} else {
  await parent();
}
