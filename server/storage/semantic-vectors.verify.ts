// Phase C verify: semantic vectors via sqlite-vec (server-side TopK search).
// Real SQLite + the real vec0 extension: upsert / search ranking / scope
// isolation / prune / clear, against a temporary HOME profile.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function vector(seed: number): number[] {
  // Unit vector biased toward `seed`: cosine/L2 ranking is deterministic.
  const values = Array.from({ length: 512 }, (_, index) => Math.sin(seed * 1000 + index) * 0.05);
  values[seed % 512] = 1;
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return values.map((v) => v / norm);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'occ-semantic-vec-verify-'));
  const previousHome = process.env.HOME;
  const previousEnv = process.env.OPENCHATCUT_SQLITE_STORE;
  process.env.HOME = root;
  process.env.OPENCHATCUT_SQLITE_STORE = '1';

  try {
    const { SQLITE_STORE_ENV } = await import('./sqlite-store.ts');
    process.env[SQLITE_STORE_ENV] = '1';
    const {
      clearSemanticVectors,
      pruneSemanticVectors,
      resetSemanticVectorsForTests,
      searchSemanticVectors,
      semanticVectorsAvailable,
      upsertSemanticVectors,
    } = await import('./semantic-vectors.ts');

    assert.equal(semanticVectorsAvailable(), true, 'the extension must load on this platform');

    // ── upsert two assets, one with multiple samples ──
    upsertSemanticVectors('project-a', 'asset-1', [
      { assetId: 'asset-1', sampleTime: 0, sourceRevision: 'rev-1', vector: vector(1) },
      { assetId: 'asset-1', sampleTime: 1, sourceRevision: 'rev-1', vector: vector(2) },
    ]);
    upsertSemanticVectors('project-a', 'asset-2', [
      { assetId: 'asset-2', sampleTime: 0, sourceRevision: 'rev-1', vector: vector(50) },
    ]);

    // ── replace semantics: re-upserting an asset drops its old samples ──
    upsertSemanticVectors('project-a', 'asset-1', [
      { assetId: 'asset-1', sampleTime: 0, sourceRevision: 'rev-2', vector: vector(1) },
    ]);

    // ── search: query close to asset-1 → asset-1 first, distances ascending ──
    const hits = searchSemanticVectors('project-a', vector(1), 10);
    assert.equal(hits.length, 2, 'both assets remain searchable');
    assert.equal(hits[0]!.assetId, 'asset-1', 'the nearest asset must rank first');
    assert.equal(hits[0]!.sourceRevision, 'rev-2', 'the replaced sample must win');
    assert.ok(hits[0]!.distance < hits[1]!.distance, 'distances must ascend');
    assert.equal(hits[1]!.assetId, 'asset-2');

    // ── scope isolation ──
    const otherScope = searchSemanticVectors('project-b', vector(1), 10);
    assert.equal(otherScope.length, 0, 'another scope must not see these vectors');

    // ── prune: stale model / missing asset / stale source revision ──
    upsertSemanticVectors('project-a', 'asset-3', [
      { assetId: 'asset-3', sampleTime: 0, sourceRevision: 'rev-old', vector: vector(3) },
    ]);
    const pruned = pruneSemanticVectors('project-a', ['asset-1', 'asset-3'],
      new Map([['asset-1', 'rev-2'], ['asset-3', 'rev-old']]));
    assert.equal(pruned.staleModelRemoved, false);
    assert.equal(pruned.staleSourceRemoved, false);
    assert.equal(searchSemanticVectors('project-a', vector(50), 10).some((h) => h.assetId === 'asset-2'), false,
      'a missing asset must be pruned');
    pruneSemanticVectors('project-a', ['asset-1', 'asset-3'],
      new Map([['asset-1', 'rev-2'], ['asset-3', 'rev-new']]));
    assert.equal(searchSemanticVectors('project-a', vector(3), 10).some((h) => h.assetId === 'asset-3'), false,
      'a stale source revision must be pruned');

    // ── input validation ──
    assert.throws(() => upsertSemanticVectors('project-a', 'asset-1', [
      { assetId: 'asset-1', sampleTime: 0, vector: [0.1] },
    ]), /invalid semantic vector sample/, 'short vectors must be rejected');
    assert.throws(() => searchSemanticVectors('bad scope!', vector(1), 10), /invalid semantic search/);

    // ── clear ──
    clearSemanticVectors('project-a');
    assert.equal(searchSemanticVectors('project-a', vector(1), 10).length, 0, 'clear must empty the scope');

    // ── reopen persistence ──
    upsertSemanticVectors('project-a', 'asset-1', [
      { assetId: 'asset-1', sampleTime: 0, sourceRevision: 'rev-3', vector: vector(7) },
    ]);
    resetSemanticVectorsForTests();
    const reopened = searchSemanticVectors('project-a', vector(7), 10);
    assert.equal(reopened.length, 1, 'vectors must survive a connection reopen');
    assert.equal(reopened[0]!.assetId, 'asset-1');

    console.log('✓ semantic-vectors verify: upsert/replace/search/scope-isolation/prune/clear/reopen all passed');
  } finally {
    if (previousEnv === undefined) delete process.env.OPENCHATCUT_SQLITE_STORE;
    else process.env.OPENCHATCUT_SQLITE_STORE = previousEnv;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
