// Runnable check: `npx tsx src/export/premiereWorkflow.verify.ts`.
// Exercise the public artifact-export route: Premiere uses its own .xml format,
// required clip bakes and planner blockers cannot commit a file, and legacy
// FCPXML still writes a distinct .fcpxml target.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { TimelineState } from '../editor/types';
import { createArtifactExporters } from './artifactExportOperations';
import type { ExportNleFormat, ExportProgress, UseExportWorkflowOptions } from './exportWorkflowTypes';

const grantId = 'premiere-workflow-verify-00000001';
assert.match(grantId, /^[A-Za-z0-9_-]{32,128}$/);

function stateOf(options: { filtered?: boolean; captions?: boolean } = {}): TimelineState {
  return {
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    items: [{
      id: 'clip-1', track: 'V1', startFrame: 0, durationInFrames: 30,
      name: 'Main Footage', kind: 'video', src: '/media/uploads/main.mp4',
      ...(options.filtered ? { filters: { brightness: 1.2 } } : {}),
    }],
    ...(options.captions ? { captions: { enabled: true } as never } : {}),
  };
}

function makeContext(
  state: TimelineState,
  nleFormat: ExportNleFormat,
  targetWrites: string[],
  progressRef: { current: ExportProgress | null },
  commitRef: { current: boolean },
) {
  progressRef.current ??= { phase: 'preparing', percent: 0, startedAt: Date.now() };
  const options = {
    state,
    projectName: 'Workflow verify',
    base: 'workflow-project',
    nleFormat,
    includeMg: false,
    mgItems: [],
  } as unknown as UseExportWorkflowOptions;
  return {
    destination: { type: 'desktop-directory', label: 'Exports', grantId } as const,
    beginTargetCommit() {},
    endTargetCommit() {},
    markTargetCommitted() { commitRef.current = true; },
    options,
    setBusy() {},
    setProgress(value: ExportProgress | null | ((current: ExportProgress | null) => ExportProgress | null)) {
      progressRef.current = typeof value === 'function' ? value(progressRef.current) : value;
    },
    t(key: string, params?: Record<string, string | number>) {
      return key.replace(/\{([^}]+)\}/g, (match, name: string) => String(params?.[name] ?? match));
    },
    targetWrites,
  };
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'occ-premiere-workflow-'));
  const uploads = join(root, 'uploads');
  mkdirSync(uploads, { recursive: true });
  writeFileSync(join(uploads, 'main.mp4'), Buffer.from('placeholder source for XML path mapping'));
  const originalFetch = globalThis.fetch;
  let failBake = false;
  let unresolvedMedia = false;
  let renderCalls = 0;
  const mediaSourceRequests: string[] = [];
  const targetWrites: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === '/api/keys') return Response.json(unresolvedMedia ? {} : { mediaDir: uploads });
    if (url === '/api/export-media-sources') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { sources?: string[] };
      const sources = body.sources ?? [];
      mediaSourceRequests.push(...sources);
      if (unresolvedMedia) return Response.json({ ok: true, sources: {} });
      return Response.json({
        ok: true,
        sources: Object.fromEntries(sources.map((source) => {
          const name = basename(source);
          const diskPath = join(uploads, name);
          if (!name.startsWith('premiere-')) writeFileSync(diskPath, Buffer.from('source'));
          else if (!failBake) writeFileSync(diskPath, Buffer.from('rendered clip'));
          return [source, {
            path: diskPath,
            pathRate: { numerator: 30, denominator: 1 },
          }];
        })),
      });
    }
    if (url === '/render-clip') {
      renderCalls += 1;
      if (failBake) return Response.json({ error: 'verification bake failure' }, { status: 500 });
      return Response.json({ path: '/media/uploads/premiere-clip-1-visual.mov' });
    }
    if (url.startsWith('/api/export-destinations/')) {
      targetWrites.push(url);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected fetch in export verify: ${url}`);
  }) as typeof fetch;

  try {
    const progressRef = { current: null as ExportProgress | null };
    const commitRef = { current: false };
    const premiere = createArtifactExporters(makeContext(stateOf(), 'premiere_xml', targetWrites, progressRef, commitRef));
    await premiere.exportXml();
    assert.ok(targetWrites.at(-1)?.endsWith('/workflow-project-premiere.xml'), 'Premiere writes the .xml target');
    assert.equal(commitRef.current, true, 'a successful XML write commits the selected destination');
    assert.ok(mediaSourceRequests.includes('/media/uploads/main.mp4'), 'original source paths are resolved at export time');

    const writesBeforeBakeFailure = targetWrites.length;
    const failedBakeProgress = { current: null as ExportProgress | null };
    const failedBakeCommit = { current: false };
    failBake = true;
    const bakeFailure = createArtifactExporters(makeContext(
      stateOf({ filtered: true }), 'premiere_xml', targetWrites, failedBakeProgress, failedBakeCommit,
    ));
    await assert.rejects(bakeFailure.exportXml(), /verification bake failure/);
    assert.equal(targetWrites.length, writesBeforeBakeFailure, 'failed required bakes never write/commit an XML target');
    assert.equal(failedBakeCommit.current, false);
    assert.equal(failedBakeProgress.current?.detail, '片段渲染失败，未生成 Premiere XML。');

    failBake = false;
    const writesBeforePlannerBlock = targetWrites.length;
    const renderCallsBeforePlannerBlock = renderCalls;
    const blockedProgress = { current: null as ExportProgress | null };
    const blocked = createArtifactExporters(makeContext(
      stateOf({ captions: true }), 'premiere_xml', targetWrites, blockedProgress, { current: false },
    ));
    await assert.rejects(blocked.exportXml(), /cannot be preserved by isolated clip bakes/);
    assert.equal(targetWrites.length, writesBeforePlannerBlock, 'blocking planner issues never write XML');
    assert.equal(renderCalls, renderCallsBeforePlannerBlock, 'planner blockers are surfaced before rendering');
    assert.ok(blockedProgress.current?.notices?.some((notice) => notice.includes('Enabled captions')),
      'blocking planner issues are visible in export progress');

    const writesBeforeOfflineMedia = targetWrites.length;
    const offlineProgress = { current: null as ExportProgress | null };
    unresolvedMedia = true;
    const offline = createArtifactExporters(makeContext(
      stateOf(), 'premiere_xml', targetWrites, offlineProgress, { current: false },
    ));
    await assert.rejects(offline.exportXml(), /没有可用的本机路径/);
    assert.equal(targetWrites.length, writesBeforeOfflineMedia, 'unresolved upload paths cannot produce a fabricated file URL');
    assert.ok(offlineProgress.current?.notices?.some((notice) => notice.includes('没有可用的本机路径')),
      'offline sources receive an explicit, visible relink error');
    unresolvedMedia = false;

    const fcp = createArtifactExporters(makeContext(stateOf(), 'fcp_xml', targetWrites, { current: null }, { current: false }));
    await fcp.exportXml();
    assert.ok(targetWrites.at(-1)?.endsWith('/workflow-project-final-cut.fcpxml'), 'FCPXML retains its separate .fcpxml output path');
    assert.equal(renderCalls, renderCallsBeforePlannerBlock, 'the legacy FCPXML route did not invoke Premiere clip bakes');
    console.log('premiereWorkflow.verify: Premiere/FCPXML routes, visible planner blockers, and required-bake failure behavior passed');
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
