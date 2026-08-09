import assert from 'node:assert/strict';
import type { MediaAsset } from '../../editor/types';
import {
  MUSIC_ANALYSIS_SCHEMA_VERSION,
  MUSIC_MODEL_PACK_FINGERPRINTS,
  type MusicAnalysis,
} from './types';
import {
  isMusicAnalysis,
  loadMusicAnalysisForAsset,
  musicAnalysisRef,
  saveMusicAnalysis,
} from './store';

const asset = {
  id: 'music-asset',
  name: 'music.wav',
  kind: 'audio',
  src: '/media/uploads/music.wav',
  durationInFrames: 30,
  sourceRevision: 'source-v1-music',
} as MediaAsset;
const embedding = Array.from({ length: 512 }, (_, index) => index === 0 ? 1 : 0);
const analysis: MusicAnalysis = {
  schemaVersion: MUSIC_ANALYSIS_SCHEMA_VERSION,
  assetId: asset.id,
  sourceRevision: asset.sourceRevision!,
  createdAt: 1,
  durationMs: 1_000,
  modelPacks: MUSIC_MODEL_PACK_FINGERPRINTS,
  bpm: 120,
  meter: 4,
  beatConfidence: 0.9,
  beatsMs: [0, 500, 1_000],
  downbeatsMs: [0],
  sections: [{
    fromMs: 0,
    toMs: 1_000,
    role: 'steady',
    energy: 0.5,
    boundaryConfidence: 0.35,
  }],
  tags: [{ kind: 'genre', label: 'electronic', score: 0.4 }],
  embedding,
};

assert.equal(isMusicAnalysis(analysis, asset.id, asset.sourceRevision), true);
await saveMusicAnalysis(analysis);
assert.deepEqual(await loadMusicAnalysisForAsset(asset), analysis);
assert.equal(await loadMusicAnalysisForAsset({ ...asset, sourceRevision: 'source-v1-relinked' }), null);
assert.match(musicAnalysisRef(analysis), /^music-analysis:v2:/);
assert.notEqual(
  musicAnalysisRef(analysis),
  musicAnalysisRef({ ...analysis, beatsMs: [0, 600, 1_000] }),
  'cut-affecting analysis changes must produce a new reference',
);
await assert.rejects(
  saveMusicAnalysis({ ...analysis, embedding: embedding.slice(1) }),
  /Refusing to cache invalid music analysis/,
);

console.log('store.verify: ok');
