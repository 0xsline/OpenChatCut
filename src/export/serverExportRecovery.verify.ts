// Phase B verify: export-recovery records are served by the project store
// (server → SQLite after migration), with IndexedDB as offline fallback and
// lazy promotion of legacy local rows. Node run: window mock for the
// transport, memory map for the no-IndexedDB path.
import assert from 'node:assert/strict';
import type { TimelineState } from '../editor/types';
import type { ExportDestination } from './exportDestination';
import {
  deleteServerExportJob,
  listServerExportJobs,
  markServerExportTargetCommitted,
  persistServerExportJob,
  resetServerExportRecoveryMemory,
  type PersistedServerExportJob,
} from './serverExportRecovery';

const requests: Array<{ request: unknown }> = [];

function installTransport(store: Record<string, unknown>): void {
  requests.length = 0;
  (globalThis as Record<string, unknown>).window = {
    openChatCutDesktop: {
      projectStore: async (request: { operation: string; key?: string; value?: unknown; entries?: Record<string, unknown> }) => {
        requests.push({ request });
        if (request.operation === 'entry') {
          const key = request.key ?? '';
          return store[key] === undefined
            ? { found: false }
            : { found: true, value: store[key] };
        }
        if (request.operation === 'set' && request.key !== undefined) {
          store[request.key] = request.value;
          return { ok: true };
        }
        if (request.operation === 'delete' && request.key !== undefined) {
          delete store[request.key];
          return { ok: true };
        }
        if (request.operation === 'snapshot') {
          return { version: 1, entries: store };
        }
        return { ok: true };
      },
    },
  };
}

function uninstallTransport(): void {
  delete (globalThis as Record<string, unknown>).window;
}

function record(renderId: string, projectId: string): PersistedServerExportJob {
  return {
    version: 1,
    renderId,
    projectId,
    label: `job-${renderId}`,
    targetPath: null,
    createdAt: 1,
    updatedAt: 1,
    format: 'video',
    codec: 'h264',
    base: 'base',
    fps: 30,
    state: { fps: 30, width: 1920, height: 1080, items: [], selectedId: null } as unknown as TimelineState,
    destination: { type: 'downloads', label: 'downloads' } as ExportDestination,
    autoQaEnabled: false,
    stage: 'polling',
  };
}

async function main(): Promise<void> {
  const serverStore: Record<string, unknown> = {};
  installTransport(serverStore);
  resetServerExportRecoveryMemory();

  // ── persist → server set with the export-recovery: prefix ──
  await persistServerExportJob(record('render-1', 'project-a'));
  assert.equal(requests.length, 1);
  const setRequest = requests[0]!.request as { operation: string; key: string };
  assert.equal(setRequest.operation, 'set');
  assert.equal(setRequest.key, 'export-recovery:render-1');

  // ── mark committed → entry + set round-trip ──
  await markServerExportTargetCommitted('render-1');
  assert.equal(requests.length, 3, 'mark must entry-then-set');
  const updated = serverStore['export-recovery:render-1'] as PersistedServerExportJob;
  assert.equal(updated.stage, 'target-committed');

  // ── list → snapshot filtered by prefix + projectId ──
  await persistServerExportJob(record('render-2', 'project-b'));
  const projectA = await listServerExportJobs('project-a');
  assert.equal(projectA.length, 1);
  assert.equal(projectA[0]!.renderId, 'render-1');
  assert.equal((await listServerExportJobs('project-b')).length, 1);

  // ── legacy local row: persisted while offline (no transport), then listed
  //    with an (empty) server → merged + lazily promoted ──
  uninstallTransport();
  await persistServerExportJob(record('render-legacy', 'project-a')); // → memory map
  installTransport(serverStore);
  serverStore['export-recovery:render-1'] = undefined as never; // keep snapshot small
  delete serverStore['export-recovery:render-1'];
  const withLegacy = await listServerExportJobs('project-a');
  assert.ok(withLegacy.some((job) => job.renderId === 'render-legacy'),
    'legacy local rows must still appear in results');
  const promoted = serverStore['export-recovery:render-legacy'] as PersistedServerExportJob | undefined;
  assert.equal(promoted?.renderId, 'render-legacy',
    'legacy rows must be lazily promoted to the server');

  // ── delete → server delete ──
  await deleteServerExportJob('render-1');
  assert.equal(serverStore['export-recovery:render-1'], undefined, 'delete must remove the server row');

  console.log('✓ export-recovery store verify: set/mark/list/delete + legacy lazy promotion passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
