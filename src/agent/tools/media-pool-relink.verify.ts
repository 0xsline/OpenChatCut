import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store';
import type { MediaAsset, TimelineItem } from '../../editor/types';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import { execMediaPoolTool } from './media-pool-tools';

const asset: MediaAsset = {
  id: 'asset_offline',
  name: 'talk.mp4',
  kind: 'video',
  src: '/media/uploads/missing.mp4',
  durationInFrames: 90,
  sourceRevision: 'source-old',
  transcript: [{ text: 'hi', start: 0, end: 200, speaker: 'A' }],
};

const clip: TimelineItem = {
  id: 'clip_offline',
  kind: 'video',
  track: 'V1',
  startFrame: 0,
  durationInFrames: 90,
  name: 'talk',
  src: asset.src,
  sourceAssetId: asset.id,
  sourceRevision: asset.sourceRevision,
  transcript: asset.transcript,
};

const draft = makeDraft(docFromTimeline({
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  assets: [asset],
  items: [clip],
  trackOrder: ['V1'],
  tracks: { V1: { kind: 'video' } },
}));

const ctx: AgentContext = {
  commands: draft.commands,
  getState: draft.getState,
  getDoc: draft.getDoc,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
};

const bad = await execMediaPoolTool(
  'manage_media_pool',
  { action: 'relink_asset', assetIds: 'asset_offline' },
  ctx,
) as { error?: string };
assert.match(bad.error ?? '', /requires src/);

const result = await execMediaPoolTool(
  'manage_media_pool',
  {
    action: 'relink_asset',
    assetIds: 'asset_off',
    src: '/media/uploads/talk-restored.mp4',
    name: 'talk-restored.mp4',
    durationInFrames: 120,
    width: 1280,
    height: 720,
    sourceFilename: 'talk-restored.mp4',
  },
  ctx,
) as {
  ok?: boolean;
  assetId?: string;
  priorSrc?: string;
  src?: string;
  transcriptStale?: boolean;
  clipsLinked?: number;
};

assert.equal(result.ok, true, JSON.stringify(result));
assert.equal(result.assetId, 'asset_offline');
assert.equal(result.priorSrc, '/media/uploads/missing.mp4');
assert.equal(result.src, '/media/uploads/talk-restored.mp4');
assert.equal(result.clipsLinked, 1);
assert.equal(result.transcriptStale, true);

const nextAsset = draft.getDoc().assets.find((row) => row.id === 'asset_offline')!;
assert.equal(nextAsset.src, '/media/uploads/talk-restored.mp4');
assert.equal(nextAsset.name, 'talk-restored.mp4');
assert.equal(nextAsset.durationInFrames, 120);
assert.equal(nextAsset.width, 1280);
assert.equal(nextAsset.height, 720);
assert.equal(nextAsset.sourceFilename, 'talk-restored.mp4');
assert.ok(nextAsset.sourceRevision && nextAsset.sourceRevision !== 'source-old');
assert.equal(nextAsset.transcriptStale, true);
assert.equal(nextAsset.transcript?.[0]?.text, 'hi');

const nextClip = draft.getState().items.find((item) => item.id === 'clip_offline')!;
assert.equal(nextClip.src, '/media/uploads/talk-restored.mp4');
assert.equal(nextClip.sourceAssetId, 'asset_offline');
assert.equal(nextClip.transcriptStale, true);
assert.equal(nextClip.durationInFrames, 120);

const mg: MediaAsset = {
  id: 'asset_mg',
  name: 'title',
  kind: 'motion-graphic',
  src: '',
  durationInFrames: 60,
  code: 'export default function Title(){return null}',
};
draft.commands.addAsset(mg);
const mgReject = await execMediaPoolTool(
  'manage_media_pool',
  { action: 'relink_asset', assetIds: 'asset_mg', src: '/media/uploads/x.mp4' },
  ctx,
) as { error?: string };
assert.match(mgReject.error ?? '', /motion graphics/i);

console.log('media-pool-relink.verify: ok');
