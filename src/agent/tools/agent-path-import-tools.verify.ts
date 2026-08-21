import assert from 'node:assert/strict';
import {
  AGENT_PATH_IMPORT_SCHEMAS,
  AGENT_PATH_IMPORT_TOOL_NAMES,
  execAgentPathImportTool,
} from './agent-path-import-tools';
import type { AgentContext } from '../context';
import type { DirectoryImportedFile } from '../../../shared/directory-import';

// ── Schema surface: two tools, both require a string path ──
const byName = new Map(AGENT_PATH_IMPORT_SCHEMAS.map((schema) => [schema.name, schema]));
assert.equal(AGENT_PATH_IMPORT_SCHEMAS.length, 2, 'exactly import_asset and import_folder');
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

// ── Browser (window exists, no desktop bridge): clear desktop-only error ──
(globalThis as unknown as { window?: unknown }).window = {};
try {
  const browserResult = await execAgentPathImportTool('import_asset', { path: '/Volumes/素材盘/A.mp4' }, {} as AgentContext);
  assert.match(String(browserResult.error), /desktop app only/, 'browser gets the desktop-only error');
  assert.equal('ok' in browserResult, false, 'browser path never reports success');
} finally {
  delete (globalThis as unknown as { window?: unknown }).window;
}

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

console.log('agent-path-import-tools.verify: schema, browser gate, and pool landing passed');
