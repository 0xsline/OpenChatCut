// Phase B verify: music-analysis results are served by the project store
// (server → SQLite after migration) with IndexedDB as offline fallback.
// Runs in Node: window.openChatCutDesktop mocks the project-store transport;
// the memory map covers the no-IndexedDB path.
import assert from 'node:assert/strict';
import type { MediaAsset } from '../../editor/types';
import { sourceRevisionOf } from '../../editor/mediaSourceRevision';
import { saveMusicAnalysis, loadMusicAnalysisForAsset } from './store';
import { MUSIC_MODEL_PACK_FINGERPRINTS } from './types';
import type { MusicAnalysis } from './types';

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

function analysis(assetId: string, sourceRevision: string): MusicAnalysis {
  return {
    schemaVersion: 1,
    assetId,
    sourceRevision,
    createdAt: 1,
    durationMs: 120_000,
    modelPacks: MUSIC_MODEL_PACK_FINGERPRINTS,
    bpm: 120,
    meter: 4,
    beatConfidence: 0.9,
    beatsMs: [0, 500],
    downbeatsMs: [0],
    sections: [{ fromMs: 0, toMs: 120_000, role: 'peak', energy: 0.8, boundaryConfidence: 0.9 }],
    tags: [{ kind: 'genre', label: 'test', score: 0.9 }],
    embedding: Array.from({ length: 512 }, () => 1 / Math.sqrt(512)), // normalized
  };
}

const ASSET = { id: 'asset-1', src: 'media/uploads/a.mp3' } as unknown as MediaAsset;

async function main(): Promise<void> {
  const serverStore: Record<string, unknown> = {};
  installTransport(serverStore);

  // ── save → server set with a hashed music-analysis: key ──
  const revision = sourceRevisionOf(ASSET);
  await saveMusicAnalysis(analysis('asset-1', revision));
  assert.equal(requests.length, 1, 'save must issue exactly one server request');
  const setRequest = requests[0]!.request as {
    operation: string;
    key: string;
    value: { analysis: MusicAnalysis };
  };
  assert.equal(setRequest.operation, 'set');
  assert.ok(/^music-analysis:[0-9a-f]{64}$/.test(setRequest.key), `key shape: ${setRequest.key}`);
  assert.equal(setRequest.value.analysis.bpm, 120, 'the stored wrapper must carry the analysis');

  // ── load (cached) → served from memory, no server round-trip ──
  const loaded = await loadMusicAnalysisForAsset(ASSET);
  assert.ok(loaded, 'load must find the analysis');
  assert.equal(loaded.bpm, 120);

  // ── load (cache-less asset) → server entry probe, miss returns null ──
  const otherAsset = { id: 'asset-2', src: 'media/uploads/b.mp3' } as unknown as MediaAsset;
  const miss = await loadMusicAnalysisForAsset(otherAsset);
  assert.equal(miss, null, 'a server miss must return null');
  const entryRequest = requests[1]?.request as { operation: string } | undefined;
  assert.equal(entryRequest?.operation, 'entry', 'a cache-less load must issue an entry request');

  // ── invalid analysis is refused on save ──
  await assert.rejects(
    saveMusicAnalysis({ schemaVersion: 1 } as unknown as MusicAnalysis),
    /Refusing to cache invalid music analysis/,
  );

  console.log('✓ music-analysis store verify: server set/entry round-trip + key shape + invalid guard passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
