import assert from 'node:assert/strict';
import {
  AGENT_PATH_IMPORT_SCHEMAS,
  AGENT_PATH_IMPORT_TOOL_NAMES,
  execAgentPathImportTool,
} from './agent-path-import-tools';
import type { AgentContext } from '../context';
import type { DirectoryImportedFile } from '../../../shared/directory-import';

// Single-path tools remain compatible alongside browse and batch import.
const byName = new Map(AGENT_PATH_IMPORT_SCHEMAS.map((schema) => [schema.name, schema]));
assert.equal(AGENT_PATH_IMPORT_SCHEMAS.length, 4);
for (const name of ['import_asset', 'import_folder']) {
  const schema = byName.get(name);
  assert.ok(schema, `${name} schema exists`);
  assert.ok(AGENT_PATH_IMPORT_TOOL_NAMES.has(name), `${name} registered in the tool name set`);
  const properties = (schema!.input_schema as { properties?: Record<string, unknown> }).properties ?? {};
  const pathProp = properties['path'] as { type?: string } | undefined;
  assert.equal(pathProp?.type, 'string', `${name} path is a string`);
  assert.ok((schema!.input_schema as { required?: string[] }).required?.includes('path'), `${name} requires path`);
  assert.match(schema!.description ?? '', /AGENT_IMPORT_ROOTS/, `${name} documents the whitelist`);
}

// ── No host at all (Node, no window and no bridge): a clear error ──
// A browser tab resolves the server routes instead; that path is covered below.
const hostless = await execAgentPathImportTool('import_asset', { path: '/Volumes/素材盘/A.mp4' }, {} as AgentContext);
assert.match(String(hostless.error), /not available on this host/, 'a hostless runtime gets a clear error');
assert.equal('ok' in hostless, false, 'a hostless runtime never reports success');
const hostlessBrowse = await execAgentPathImportTool('browse_local_media', { path: '/media' }, {} as AgentContext);
assert.match(String(hostlessBrowse.error), /not available on this host/, 'browsing is refused the same way');

// ── Missing path: rejected before any bridge call ──
const desktopBridge = {
  calls: [] as Array<{ paths: readonly string[]; projectId: string }>,
  async importAgentPaths(request: { paths: readonly string[]; projectId: string; knownHashes: readonly string[] }) {
    this.calls.push(request);
    return { imported: [], errors: [], unsupportedFiles: [], duplicateCount: 0 };
  },
};
(globalThis as unknown as { window?: unknown }).window = { openChatCutDesktop: desktopBridge };
try {
  const empty = await execAgentPathImportTool('import_asset', { path: '   ' }, {} as AgentContext);
  assert.match(String(empty.error), /path is required/, 'blank path rejected');
  assert.equal(desktopBridge.calls.length, 0, 'no bridge call for a blank path');
} finally {
  delete (globalThis as unknown as { window?: unknown }).window;
}

// ── Desktop with an open project: imports land in the pool ──
const importedFile: Omit<DirectoryImportedFile, 'importId'> = {
  name: 'A001.mp4',
  src: '/media/uploads/a001.mp4',
  storedName: 'a001.mp4',
  contentHash: 'a'.repeat(64),
  kind: 'video',
  size: 1234,
  sourceModifiedAt: 1786400000000,
  durationSeconds: 12,
  width: 1920,
  height: 1080,
  sourceFps: 30,
  compatibilityNormalized: true,
};
const addedAssets: Array<{ id: string; name: string }> = [];
const projectCtx = {
  getProjectId: () => 'project-84',
  getState: () => ({ fps: 30 }),
  getDoc: () => ({ assets: [] }),
  commands: { addAsset: (asset: { id: string; name: string }) => { addedAssets.push(asset); } },
} as unknown as AgentContext;
(globalThis as unknown as { window?: unknown }).window = {
  openChatCutDesktop: {
    async importAgentPaths(_request: { paths: readonly string[]; projectId: string; knownHashes: readonly string[] }) {
      return { imported: [{ ...importedFile, importId: 'import-1' }], errors: [], unsupportedFiles: [], duplicateCount: 0 };
    },
  },
};
try {
  const result = await execAgentPathImportTool('import_asset', { path: '/Volumes/素材盘/A001.mp4' }, projectCtx);
  assert.equal(result.ok, true, 'desktop import reports ok');
  assert.equal(addedAssets.length, 1, 'the imported asset lands in the pool');
  assert.equal(addedAssets[0]!.name, 'A001.mp4', 'asset name preserved');
  const listed = (result as { imported?: Array<{ name: string }> }).imported;
  assert.equal(listed?.[0]?.name, 'A001.mp4', 'result lists the asset');
} finally {
  delete (globalThis as unknown as { window?: unknown }).window;
}

// ── Missing roots are actionable and never reported as a successful import ──
(globalThis as unknown as { window?: unknown }).window = {
  openChatCutDesktop: {
    async importAgentPaths() {
      return {
        imported: [], unsupportedFiles: [], duplicateCount: 0,
        errors: [{
          path: '/Volumes/素材盘',
          code: 'IMPORT_ROOTS_NOT_CONFIGURED' as const,
          error: '尚未添加本地素材目录。请在“设置 → 本地素材目录”中添加。',
        }],
      };
    },
  },
};
try {
  const result = await execAgentPathImportTool('import_folder', { path: '/Volumes/素材盘' }, projectCtx);
  assert.equal(result.code, 'IMPORT_ROOTS_NOT_CONFIGURED');
  assert.match(String(result.error), /设置.*本地素材目录/);
  assert.equal('ok' in result, false, 'configuration failure is not a successful tool result');
} finally {
  delete (globalThis as unknown as { window?: unknown }).window;
}

// ── Unsupported documents are distinguished from known media ──
(globalThis as unknown as { window?: unknown }).window = {
  openChatCutDesktop: {
    async importAgentPaths() {
      return { imported: [], errors: [], unsupportedFiles: ['说明.md'], duplicateCount: 2 };
    },
  },
};
try {
  const result = await execAgentPathImportTool('import_folder', { path: '/Volumes/素材盘' }, projectCtx);
  assert.deepEqual(result.unsupportedFiles, ['说明.md']);
  assert.equal(result.duplicateCount, 2);
  assert.equal(result.skippedDuplicates, false, 'mixed skipped reasons are not mislabeled');
} finally {
  delete (globalThis as unknown as { window?: unknown }).window;
}

// ── Desktop without an open project ──
(globalThis as unknown as { window?: unknown }).window = { openChatCutDesktop: desktopBridge };
try {
  const noProject = await execAgentPathImportTool('import_folder', { path: '/Volumes/素材盘' }, { getProjectId: () => undefined } as unknown as AgentContext);
  assert.match(String(noProject.error), /no open project/, 'missing project rejected');
} finally {
  delete (globalThis as unknown as { window?: unknown }).window;
}

// ── Bridge failure surfaces the message ──
(globalThis as unknown as { window?: unknown }).window = {
  openChatCutDesktop: {
    async importAgentPaths() { throw new Error('scan failed: EACCES'); },
  },
};
try {
  const failed = await execAgentPathImportTool('import_asset', { path: '/Volumes/素材盘/A.mp4' }, projectCtx);
  assert.match(String(failed.error), /scan failed/, 'bridge error message surfaced');
} finally {
  delete (globalThis as unknown as { window?: unknown }).window;
}

console.log('agent-path-import-tools.verify: schema, host resolution, and pool landing passed');

const localCalls: unknown[] = [];
(globalThis as unknown as { window?: unknown }).window = {
  openChatCutDesktop: {
    async browseLocalMedia(request: unknown) {
      localCalls.push(request);
      return { path: '/media', entries: [{ path: '/media/take.mp4', name: 'take.mp4', kind: 'video' }], nextOffset: null, truncated: false, errors: [] };
    },
    async importAgentPaths(request: unknown) {
      localCalls.push(request);
      return { imported: [importedFile], errors: [], unsupportedFiles: [], duplicateCount: 1 };
    },
  },
};
try {
  const search = await execAgentPathImportTool('browse_local_media', { path: '/media', kind: 'video' }, {} as AgentContext);
  assert.equal(search.ok, true, 'browsing does not require a project or mutate the pool');
  assert.deepEqual(localCalls[0], { path: '/media', kind: 'video' });
  const batch = await execAgentPathImportTool('import_assets', { paths: ['/media/take.mp4', '/media/duplicate.mp4'] }, projectCtx);
  assert.equal(batch.ok, true);
  assert.equal(batch.duplicateCount, 1);
  assert.equal(addedAssets.length, 2, 'batch import publishes its imported asset');
  assert.deepEqual(localCalls[1], { paths: ['/media/take.mp4', '/media/duplicate.mp4'], projectId: 'project-84', knownHashes: [] });
  for (const paths of [[], [''], [123], Array(101).fill('/media/take.mp4')]) {
    assert.ok((await execAgentPathImportTool('import_assets', { paths }, projectCtx)).error);
  }
  assert.equal(localCalls.length, 2, 'invalid batches never reach the bridge');
  assert.ok((await execAgentPathImportTool('browse_local_media', { limit: 0 }, projectCtx)).error);
  assert.ok((await execAgentPathImportTool('unknown', {}, projectCtx)).error);
  let reads = 0;
  const switchedContext = { ...projectCtx, getProjectId: () => ++reads === 1 ? 'project-84' : 'another-project' } as AgentContext;
  const switched = await execAgentPathImportTool('import_assets', { paths: ['/media/take.mp4'] }, switchedContext);
  assert.match(String(switched.error), /project changed/);
  assert.equal(addedAssets.length, 2, 'switching projects cannot publish imported assets into another pool');
} finally {
  delete (globalThis as unknown as { window?: unknown }).window;
}
console.log('agent-path-import-tools.verify: discovery and batch import passed');

// ── Browser without the desktop bridge: the same-origin server routes (#185) ──
const httpCalls: Array<{ url: string; body: unknown }> = [];
const originalFetch = globalThis.fetch;
(globalThis as unknown as { window?: unknown }).window = {};
globalThis.fetch = async (input, init) => {
  const url = String(input);
  const body: unknown = JSON.parse(String(init?.body ?? '{}'));
  httpCalls.push({ url, body });
  if (url.endsWith('/browse')) {
    return Response.json({
      path: '/media',
      entries: [{ path: '/media/take.mp4', name: 'take.mp4', kind: 'video' }],
      nextOffset: null,
      truncated: false,
      errors: [],
    });
  }
  if ((body as { knownHashes?: readonly string[] }).knownHashes?.length) {
    return Response.json({ imported: [], errors: [], unsupportedFiles: [], duplicateCount: 1 });
  }
  return Response.json({ imported: [importedFile], errors: [], unsupportedFiles: [], duplicateCount: 0 });
};
try {
  const listed = await execAgentPathImportTool('browse_local_media', { path: '/media', kind: 'video' }, {} as AgentContext);
  assert.equal(listed.ok, true, 'a browser tab browses through the server route');
  assert.equal(httpCalls[0]?.url, '/api/local-media/browse');
  assert.deepEqual(httpCalls[0]?.body, { path: '/media', kind: 'video' });

  const before = addedAssets.length;
  const imported = await execAgentPathImportTool('import_asset', { path: '/media/take.mp4' }, projectCtx);
  assert.equal(imported.ok, true, 'a browser tab imports through the server route');
  assert.equal(httpCalls[1]?.url, '/api/local-media/import');
  assert.deepEqual(httpCalls[1]?.body, { paths: ['/media/take.mp4'], projectId: 'project-84', knownHashes: [] });
  assert.equal(addedAssets.length, before + 1, 'the server import lands in the pool');

  const dedupeCtx = {
    ...projectCtx,
    getDoc: () => ({ assets: [{ sourceContentHash: 'b'.repeat(64) }] }),
  } as unknown as AgentContext;
  const skipped = await execAgentPathImportTool('import_asset', { path: '/media/take.mp4' }, dedupeCtx);
  assert.deepEqual(
    httpCalls[2]?.body,
    { paths: ['/media/take.mp4'], projectId: 'project-84', knownHashes: ['b'.repeat(64)] },
    'the pool content hashes ride along for server-side dedupe',
  );
  assert.equal(skipped.ok, true);
  assert.equal(skipped.duplicateCount, 1, 'the server duplicate count is surfaced');
  assert.equal(skipped.skippedDuplicates, true, 'an all-duplicate batch is labelled');
  assert.equal(addedAssets.length, before + 1, 'a duplicate adds nothing to the pool');
} finally {
  globalThis.fetch = originalFetch;
  delete (globalThis as unknown as { window?: unknown }).window;
}

// ── A server refusal keeps its actionable code ──
const codeFetch = globalThis.fetch;
(globalThis as unknown as { window?: unknown }).window = {};
globalThis.fetch = async () => Response.json(
  { error: 'set AGENT_IMPORT_ROOTS', code: 'IMPORT_ROOTS_NOT_CONFIGURED' },
  { status: 403 },
);
try {
  const blocked = await execAgentPathImportTool('import_folder', { path: '/Volumes/素材盘' }, projectCtx);
  assert.equal(blocked.code, 'IMPORT_ROOTS_NOT_CONFIGURED', 'the server code survives the tool envelope');
  assert.equal('ok' in blocked, false, 'a refusal is not a successful tool result');
  const blockedBrowse = await execAgentPathImportTool('browse_local_media', { path: '/Volumes/素材盘' }, projectCtx);
  assert.equal(blockedBrowse.code, 'IMPORT_ROOTS_NOT_CONFIGURED');
} finally {
  globalThis.fetch = codeFetch;
  delete (globalThis as unknown as { window?: unknown }).window;
}

// ── When the desktop bridge exists, the server routes are never used ──
const bridgeFetch = globalThis.fetch;
let bridgeCalls = 0;
(globalThis as unknown as { window?: unknown }).window = {
  openChatCutDesktop: {
    async browseLocalMedia() {
      bridgeCalls += 1;
      return { path: '/media', entries: [], nextOffset: null, truncated: false, errors: [] };
    },
  },
};
globalThis.fetch = async () => { throw new Error('the HTTP fallback must not run in the desktop app'); };
try {
  const bridged = await execAgentPathImportTool('browse_local_media', { path: '/media' }, {} as AgentContext);
  assert.equal(bridged.ok, true, 'the desktop bridge still serves the tool');
  assert.equal(bridgeCalls, 1, 'the Electron bridge is preferred over the server routes');
} finally {
  globalThis.fetch = bridgeFetch;
  delete (globalThis as unknown as { window?: unknown }).window;
}
console.log('agent-path-import-tools.verify: browser HTTP fallback and error codes passed');
