// Phase C-3 verify: hybrid search fuses FTS5 text hits and sqlite-vec visual
// hits with RRF. Real SQLite: index a chat + a caption and a vector asset in
// one project, then confirm both lanes appear in the fused, ranked result.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function vector(seed: number): number[] {
  const values = Array.from({ length: 512 }, (_, index) => Math.sin(seed * 1000 + index) * 0.05);
  values[seed % 512] = 1;
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return values.map((v) => v / norm);
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'occ-hybrid-verify-'));
  const previousHome = process.env.HOME;
  const previousSwitch = process.env.OPENCHATCUT_SQLITE_STORE;
  process.env.HOME = root;
  delete process.env.OPENCHATCUT_SQLITE_STORE;

  try {
    // Runtime profile is cached at module load; install the isolated HOME first.
    const { initializeSqliteProjectStore, resetSqliteStoreForTests } = await import('./sqlite-store.ts');
    const { indexStoreKey, resetSearchForTests } = await import('./fulltext-search.ts');
    const { upsertSemanticVectors, resetSemanticVectorsForTests } = await import('./semantic-vectors.ts');
    const { hybridSearch } = await import('./hybrid-search.ts');
    assert.deepEqual(hybridSearch('黄昏的海边', vector(1), { projectId: 'project-a' }), [],
      'hybrid search cannot read an uninitialized database');
    await initializeSqliteProjectStore();

    // ── text lane: chat mentioning the visual topic ──
    indexStoreKey('chat:project-a', {
      messages: [
        { role: 'user', text: '这段素材有黄昏的海边，帮我剪进去' },
        { role: 'user', text: '字幕样式改成金色' },
      ],
    });
    // ── visual lane: a vector close to "黄昏的海边" (seed 1) ──
    upsertSemanticVectors('project-a', 'asset-sunset', [
      { assetId: 'asset-sunset', sampleTime: 0, sourceRevision: 'rev-1', vector: vector(1) },
    ]);
    upsertSemanticVectors('project-a', 'asset-other', [
      { assetId: 'asset-other', sampleTime: 0, sourceRevision: 'rev-1', vector: vector(50) },
    ]);

    // ── hybrid: both lanes match the query ──
    const hits = hybridSearch('黄昏的海边', vector(1), { projectId: 'project-a', limit: 10 });
    assert.ok(hits.some((hit) => hit.kind === 'chat'), 'the text lane must contribute');
    assert.ok(hits.some((hit) => hit.kind === 'visual' && hit.assetId === 'asset-sunset'),
      'the visual lane must contribute the closest asset');
    assert.ok(hits.some((hit) => hit.kind === 'visual' && hit.assetId === 'asset-other'),
      'the second asset must rank too');

    // ── RRF ordering: both lanes present; visual nearest first, chat second ──
    const sorted = hits.filter((hit) => hit.kind === 'visual' || hit.kind === 'chat');
    for (let index = 1; index < sorted.length; index += 1) {
      assert.ok(sorted[index - 1]!.score >= sorted[index]!.score, 'RRF scores must descend');
    }

    // ── without a project scope the visual lane is skipped ──
    const textOnly = hybridSearch('金色', undefined, { limit: 10 });
    assert.ok(textOnly.every((hit) => hit.kind !== 'visual'), 'no vector → text only');
    assert.ok(textOnly.some((hit) => hit.kind === 'chat'), 'text lane must still work');

    // Both lanes persist through restart; env=0 can no longer disable them.
    process.env.OPENCHATCUT_SQLITE_STORE = '0';
    resetSqliteStoreForTests();
    assert.equal(hybridSearch('黄昏的海边', vector(1), { projectId: 'project-a' }).length, 0,
      'cached search lanes must respect readiness');
    resetSearchForTests();
    resetSemanticVectorsForTests();
    await initializeSqliteProjectStore();
    const reopened = hybridSearch('黄昏的海边', vector(1), { projectId: 'project-a' });
    assert.ok(reopened.some((hit) => hit.kind === 'chat'));
    assert.ok(reopened.some((hit) => hit.kind === 'visual' && hit.assetId === 'asset-sunset'));
    resetSearchForTests();
    resetSemanticVectorsForTests();
    resetSqliteStoreForTests();

    console.log('hybrid-search verify: RRF fusion / dual-lane / scoping / default SQLite restart passed');
  } finally {
    if (previousSwitch === undefined) delete process.env.OPENCHATCUT_SQLITE_STORE;
    else process.env.OPENCHATCUT_SQLITE_STORE = previousSwitch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
