import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Runnable with: `npx tsx server/external-agent/offline-export.verify.ts`.
// Never touches real projects: stubs replace the export pipeline entirely, and
// the media-dir module reads its profile home lazily (not at import time).

const { EXPORT_VIDEO_TOOL_SCHEMA } = await import('../../src/agent/tools/schemas/external-export-tools.js');
const { assertValidAgentToolSchemas, policyForTool } = await import('../../src/agent/execution-policy.ts');
const { offlineExternalToolSchemas } = await import('./offline-tools.ts');
const { isExternalServerDirectTool } = await import('../../src/agent/external-tool-policy.ts');
const { assertOfflineToolAllowed } = await import('./offline-tool-authorization.ts');
const {
  executeOfflineExportVideo,
  exportRequestFromDraft,
} = await import('./offline-export.ts');
const { projectDoc } = await import('./offline-runtime.verify-fixtures.ts');

const catalog = offlineExternalToolSchemas();
const tool = catalog.find((schema) => schema.name === 'export_video');
assert.ok(tool, 'export_video is in the offline catalog');
assert.match(tool.description ?? '', /absolute path/);
assert.equal(tool.input_schema.properties?.timeoutSeconds?.maximum, 3600);
assert.equal(isExternalServerDirectTool('export_video'), true);
assert.equal(policyForTool('export_video').effect, 'persistent_local');
assertValidAgentToolSchemas([EXPORT_VIDEO_TOOL_SCHEMA]);

// Authorization gate: allowed, exactly like the other server-direct tools.
assert.doesNotThrow(() => assertOfflineToolAllowed('export_video', {}, 'http://localhost'));

// Request building from a draft: state/project active timeline.
const request = exportRequestFromDraft({ getDoc: () => projectDoc() } as never);
assert.equal(request.state?.id, 'timeline-1');
assert.equal(request.timelineId, 'timeline-1');

const uploadDirPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'media', 'uploads');
type Result = Record<string, unknown>;

// A completed job result is promoted to a managed name; filePath joins the
// uploads dir with the safe upload name.
const completed = await executeOfflineExportVideo('export_video', { timeoutSeconds: 3 }, { getDoc: () => projectDoc() } as never, {
  startExportJob: async () => 'render-1',
  getGenerationJobSnapshot: (id) => id !== 'render-1' ? null : {
    id,
    operationId: id,
    status: 'succeeded',
    progress: 100,
    retryClass: 'none',
    timestamps: { createdAt: 0, submittedAt: 0, updatedAt: 0 },
    createdAt: 0,
    updatedAt: 0,
    params: {},
    retentionMs: 60_000,
    result: {
      assetId: 'asset-1',
      kind: 'video',
      name: 'timeline-1.mp4',
      path: '/media/uploads/openchatcut-export-job-asset-1.mp4',
      durationSeconds: 6,
      sizeBytes: 1024,
      codec: 'h264',
      width: 1920,
      height: 1080,
      fps: 30,
    },
  },
  promoteExportResult: async (result) => ({
    ...result,
    path: '/media/uploads/openchatcut-derived-asset-1.mp4',
    sizeBytes: 1024,
  }),
  uploadDir: () => uploadDirPath,
  sleep: () => Promise.resolve(),
  now: () => Date.now(),
}) as Result;
assert.equal(completed.status, 'completed');
assert.equal(completed.renderId, 'render-1');
assert.equal(completed.path, '/media/uploads/openchatcut-derived-asset-1.mp4');
assert.equal(completed.filePath, join(uploadDirPath, 'openchatcut-derived-asset-1.mp4'));
assert.equal(completed.codec, 'h264');
assert.equal(completed.durationSeconds, 6);

// Resume-by-renderId: no new render is started.
let started = 0;
const resumed = await executeOfflineExportVideo('export_video', { renderId: 'render-1' }, { getDoc: () => projectDoc() } as never, {
  startExportJob: async () => { started += 1; return 'render-2'; },
  getGenerationJobSnapshot: () => null,
  promoteExportResult: async (result) => result,
  uploadDir: () => uploadDirPath,
  sleep: () => Promise.resolve(),
  now: () => Date.now(),
}) as Result;
assert.equal(started, 0);
assert.match(String(resumed.error), /not found/);

// Non-terminal job with a bounded wait returns a background hint.
let clock = 0;
const waiting = await executeOfflineExportVideo('export_video', { timeoutSeconds: 1 }, { getDoc: () => projectDoc() } as never, {
  startExportJob: async () => 'render-3',
  getGenerationJobSnapshot: (id) => id !== 'render-3' ? null : {
    id,
    operationId: id,
    status: 'running',
    progress: 40,
    phase: 'rendering',
    processedFrames: 72,
    totalFrames: 180,
    retryClass: 'none',
    timestamps: { createdAt: 0, submittedAt: 0, updatedAt: 0 },
    createdAt: 0,
    updatedAt: 0,
    params: {},
    retentionMs: 60_000,
  },
  promoteExportResult: async (result) => result,
  uploadDir: () => uploadDirPath,
  sleep: async () => { clock += 2_000; },
  now: () => clock,
}) as Result;
assert.equal(waiting.status, 'running');
assert.equal(waiting.waitExpired, true);
assert.equal(waiting.background, true);

// Failed jobs surface the job error instead of throwing.
const failed = await executeOfflineExportVideo('export_video', {}, { getDoc: () => projectDoc() } as never, {
  startExportJob: async () => 'render-4',
  getGenerationJobSnapshot: (id) => id !== 'render-4' ? null : {
    id,
    operationId: id,
    status: 'failed',
    progress: 100,
    phase: 'failed',
    error: 'encode failed',
    code: 'export_output_unreadable',
    retryable: true,
    retryClass: 'provider-terminal',
    timestamps: { createdAt: 0, submittedAt: 0, updatedAt: 0 },
    createdAt: 0,
    updatedAt: 0,
    params: {},
    retentionMs: 60_000,
  },
  promoteExportResult: async (result) => result,
  uploadDir: () => uploadDirPath,
  sleep: () => Promise.resolve(),
  now: () => Date.now(),
}) as Result;
assert.equal(failed.status, 'failed');
assert.equal(failed.code, 'export_output_unreadable');
assert.equal(failed.error, 'encode failed');

console.log('offline-export.verify: ok');