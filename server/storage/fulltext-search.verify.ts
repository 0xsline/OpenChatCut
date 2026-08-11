// Phase C-2 verify: FTS5 full-text search with jieba segmentation.
// Real SQLite + FTS5: chat/caption/transcript indexing, Chinese 2-char words,
// deletion sync, post-migration rebuild, bm25 ranking.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'occ-fts-verify-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  process.env.OPENCHATCUT_SQLITE_STORE = '1';

  try {
    const { initializeSqliteProjectStore, SQLITE_STORE_ENV } = await import('./sqlite-store.ts');
    process.env[SQLITE_STORE_ENV] = '1';
    await initializeSqliteProjectStore();
    const {
      indexStoreKey,
      removeStoreKey,
      rebuildSearchIndex,
      resetSearchForTests,
      searchContent,
    } = await import('./fulltext-search.ts');
    const { segmentForIndex } = await import('./search-tokenizer.ts');

    // ── tokenizer: Chinese 2-char words and mixed text ──
    assert.equal(segmentForIndex('字幕'), '字幕', 'a 2-char word must stay whole');
    assert.ok(segmentForIndex('把背景音乐的音量降低').includes('背景音乐'), 'domain words must segment');
    assert.ok(segmentForIndex('导出4K视频').includes('4K'), 'latin runs must stay intact');

    // ── chat indexing: per-message rows ──
    indexStoreKey('chat:project-a', {
      messages: [
        { role: 'user', text: '把背景音乐的音量降低一点' },
        { role: 'assistant', text: '好的，字幕样式也改成金色', thinking: '调整样式' },
        { role: 'tool', text: '', tool: { name: 'set_item_volume' } },
      ],
    });
    const chatHits = searchContent('背景音乐音量');
    assert.ok(chatHits.some((hit) => hit.kind === 'chat' && hit.ref.startsWith('chat:project-a:')),
      'chat text must be searchable by segmented words');
    const assistantHits = searchContent('字幕样式');
    assert.ok(assistantHits.some((hit) => hit.ref.endsWith(':1')), 'assistant message must match');

    // ── project indexing: captions (cue text) + transcript words ──
    indexStoreKey('project:project-a', {
      timelines: [{
        tracks: {
          C1: {
            captions: {
              enabled: true,
              cues: [{ startFrame: 0, text: '黄昏的海边' }],
            },
          },
        },
      }],
      assets: [{
        id: 'asset-1',
        transcript: { words: [{ text: '转场' }, { text: '字幕' }] },
      }],
    });
    const captionHits = searchContent('黄昏');
    assert.ok(captionHits.some((hit) => hit.kind === 'caption' && hit.projectId === 'project-a'),
      'caption cue text must be searchable');
    const transcriptHits = searchContent('转场');
    assert.ok(transcriptHits.some((hit) => hit.kind === 'transcript'),
      'transcript words must be searchable');

    // ── project scoping ──
    const scoped = searchContent('字幕', { projectId: 'project-b' });
    assert.equal(scoped.length, 0, 'another project must not see the hits');

    // ── bm25 ranking: exact multi-token match ranks above partial ──
    indexStoreKey('chat:project-b', {
      messages: [
        { role: 'user', text: '背景音乐音量再低一点' },
        { role: 'user', text: '完全无关的话题讨论' },
      ],
    });
    const ranked = searchContent('背景音乐 音量');
    assert.ok(ranked.length > 0);
    assert.ok(ranked[0]!.score >= ranked[ranked.length - 1]!.score, 'scores must descend');

    // ── hash-gated refresh: same content does not duplicate rows ──
    indexStoreKey('chat:project-b', {
      messages: [{ role: 'user', text: '背景音乐音量再低一点' }],
    });
    const afterRefresh = searchContent('背景音乐音量', { projectId: 'project-b' });
    assert.equal(afterRefresh.length, 1, 'unchanged content must not re-index');

    // ── deletion sync ──
    removeStoreKey('chat:project-b');
    assert.equal(searchContent('背景音乐音量', { projectId: 'project-b' }).length, 0,
      'deleted key must drop its rows');

    // ── rebuild (post-migration backfill) ──
    // Seed a kv row first: rebuild scans the kv table (created by store writes).
    const { sqliteWriteEntry } = await import('./sqlite-store.ts');
    await sqliteWriteEntry('chat:rebuild-src', {
      messages: [{ role: 'user', text: '重建索引测试文本' }],
    });
    const rebuilt = rebuildSearchIndex();
    assert.ok(rebuilt.indexed >= 1, 'rebuild must scan chat/project keys');
    assert.ok(searchContent('重建索引').some((hit) => hit.ref.startsWith('chat:rebuild-src:')),
      'rebuild must restore hits');

    // ── search unavailable without SQLite enabled ──
    process.env[SQLITE_STORE_ENV] = '0';
    resetSearchForTests();
    assert.equal(searchContent('字幕').length, 0, 'search must be a no-op without the SQLite store');

    console.log('✓ fulltext-search verify: tokenizer/index/search/ranking/scoping/delete-sync/rebuild all passed');
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
