// A command that has to CREATE a track must commit the track and the clip in
// one step. They used to be two dispatches, so the first undo removed the clip
// and left an empty track behind — the user had to press undo twice.
// npx tsx src/editor/trackCreateBatching.verify.ts
import assert from 'node:assert/strict';
import { buildCommands } from './storeCommandBuilder';
import { projectReduce } from './reduce';
import type { AnyAction } from './reduce';
import type { MediaAsset, ProjectDoc } from './types';

function harness(doc: ProjectDoc) {
  const dispatched: AnyAction[] = [];
  let current = doc;
  const commands = buildCommands((action) => {
    dispatched.push(action);
    current = projectReduce(current, action);
  }, () => current);
  return { commands, dispatched, doc: () => current };
}

const videoOnlyDoc = (): ProjectDoc => ({
  version: 3,
  assets: [],
  mediaFolders: [],
  timelines: [{
    id: 'tl1', name: '序列 1', fps: 30, width: 1920, height: 1080,
    selectedId: null, items: [],
    trackOrder: ['track_v1'],
    tracks: { track_v1: { kind: 'video' } },
  }],
  activeTimelineId: 'tl1',
} as unknown as ProjectDoc);

const audioAsset: MediaAsset = {
  id: 'asset-audio', name: 'bgm', kind: 'audio', src: '/media/uploads/bgm.mp3',
  durationInFrames: 300,
} as MediaAsset;

// ── 需要新建音轨:一次 dispatch(batch),撤销一次即干净 ──────────────────────
{
  const { commands, dispatched, doc } = harness(videoOnlyDoc());
  commands.addMediaItem(audioAsset, {});
  assert.equal(dispatched.length, 1,
    'creating a track and adding the clip must be ONE dispatch, not two');
  assert.equal(dispatched[0]!.type, 'batch', 'they are committed as a batch');
  const actions = (dispatched[0] as Extract<AnyAction, { type: 'batch' }>).actions;
  assert.ok(actions.some((a) => a.type === 'track.create'), 'the batch creates the track');
  assert.ok(actions.some((a) => a.type === 'add'), 'the batch adds the clip');
  const timeline = doc().timelines[0]!;
  assert.equal(timeline.items.length, 1, 'the clip landed');
  assert.equal(Object.values(timeline.tracks ?? {}).some((t) => t.kind === 'audio'), true,
    'the audio track was created');
}

// ── 目标轨已存在:仍是单条 add,不产生多余 batch ─────────────────────────────
{
  const withAudio = videoOnlyDoc();
  const timeline = withAudio.timelines[0]! as unknown as {
    trackOrder: string[]; tracks: Record<string, { kind: string }>;
  };
  timeline.trackOrder = ['track_v1', 'track_a1'];
  timeline.tracks = { track_v1: { kind: 'video' }, track_a1: { kind: 'audio' } };

  const { commands, dispatched } = harness(withAudio);
  commands.addMediaItem(audioAsset, {});
  assert.equal(dispatched.length, 1, 'still one dispatch');
  assert.equal(dispatched[0]!.type, 'add',
    'no track needed → a plain add, unchanged from before');
}

// ── 纯色片段:已有视频轨时不触发建轨 ────────────────────────────────────────
{
  const { commands, dispatched } = harness(videoOnlyDoc());
  commands.addSolidItem({});
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]!.type, 'add', 'existing video track → plain add');
}

console.log('trackCreateBatching.verify: ok');
