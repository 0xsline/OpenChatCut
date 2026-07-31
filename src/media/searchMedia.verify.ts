import assert from 'node:assert/strict';
import type { MediaAsset } from '../editor/types';
import { sourceRevisionOf } from '../editor/mediaSourceRevision';
import {
  buildMediaSearchResult,
  filterStaleMediaSearchHits,
  spokenMediaSearchHits,
  visualMediaSearchHits,
  type SpokenMediaSearchHit,
  type VisualMediaSearchHit,
} from './searchMedia';

const asset = (id: string, sourceRevision: string, transcriptStale = false): MediaAsset => ({
  id,
  name: id,
  kind: 'video',
  src: `/media/uploads/${id}.mp4`,
  durationInFrames: 300,
  sourceRevision,
  transcriptStale,
  transcript: [
    { text: '你好', start: 1_000, end: 1_350 },
    { text: '世界', start: 1_400, end: 1_900 },
  ],
});

const assets = [asset('fresh', 'rev-2'), asset('stale-transcript', 'rev-4', true)];
const visual = visualMediaSearchHits([
  {
    assetId: 'fresh', sourceRevision: 'rev-2', sampleTime: 4.5, sceneId: 'shot-2',
    sceneStart: 4, sceneEnd: 5, score: 0.8,
  },
  {
    assetId: 'fresh', sourceRevision: 'rev-1', sampleTime: 2, sceneId: 'old-shot',
    sceneStart: 1, sceneEnd: 3, score: 0.99,
  },
], assets);
assert.equal(visual.length, 1, 'visual hits from a replaced source revision are filtered');
assert.deepEqual(
  { start: visual[0]?.sourceStartMs, end: visual[0]?.sourceEndMs, sample: visual[0]?.sampleTimeMs },
  { start: 4_000, end: 5_000, sample: 4_500 },
  'visual hits expose a source-locatable scene time range',
);
assert.ok((visual[0]?.score ?? 0) >= 0 && (visual[0]?.score ?? 0) <= 1);

const spoken = spokenMediaSearchHits('你好世界', assets);
assert.equal(spoken.length, 1, 'stale transcripts do not leak into unified search');
assert.deepEqual(
  { start: spoken[0]?.sourceStartMs, end: spoken[0]?.sourceEndMs },
  { start: 1_000, end: 1_900 },
);
assert.equal(spoken[0]?.sourceRevision, sourceRevisionOf(assets[0]!));

const visualUnsorted: VisualMediaSearchHit[] = [
  { ...visual[0]!, score: 0.4, sourceStartMs: 8_000, sourceEndMs: 9_000, sampleTimeMs: 8_500 },
  { ...visual[0]!, score: 0.9, sourceStartMs: 2_000, sourceEndMs: 3_000, sampleTimeMs: 2_500 },
];
const spokenUnsorted: SpokenMediaSearchHit[] = [
  { ...spoken[0]!, score: 0.3, sourceStartMs: 7_000, sourceEndMs: 8_000 },
  { ...spoken[0]!, score: 0.8, sourceStartMs: 5_000, sourceEndMs: 6_000 },
];
const grouped = buildMediaSearchResult('query', visualUnsorted, spokenUnsorted, assets);
assert.deepEqual(grouped.visual.map((hit) => hit.score), [0.9, 0.4]);
assert.deepEqual(grouped.spoken.map((hit) => hit.score), [0.8, 0.3]);
assert.deepEqual(grouped.hits.map((hit) => hit.modality), ['visual', 'visual', 'spoken', 'spoken']);

assert.equal(filterStaleMediaSearchHits([{
  ...visual[0]!, sourceRevision: 'rev-before-relink',
}], assets).length, 0, 'a late result is rejected again at the unified return boundary');

console.log('searchMedia.verify: ok');
