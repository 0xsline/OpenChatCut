import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store.ts';
import type { ProjectDoc, Timeline } from '../../editor/types.ts';
import type { AgentContext } from '../context.ts';
import { execAudioAssetTool } from './audio-asset-tools.ts';
import { CURRENT_PROJECT_VERSION } from '../../../shared/project-version';

const timeline: Timeline = {
  id: 'tl_audio_assets',
  name: 'audio assets',
  order: 0,
  fps: 30,
  width: 1920,
  height: 1080,
  items: [],
  selectedId: null,
  trackOrder: ['V1', 'A1'],
  tracks: {
    V1: { kind: 'video', name: 'Video' },
    A1: { kind: 'audio', name: 'Audio' },
  },
};
const doc: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION,
  assets: [{
    id: 'asset_voice_qa',
    name: 'Generated Voice',
    kind: 'audio',
    src: '/media/uploads/generated.mp3',
    durationInFrames: 90,
  }],
  mediaFolders: [],
  timelines: [timeline],
  activeTimelineId: timeline.id,
};
const draft = makeDraft(doc);
const ctx: AgentContext = {
  commands: draft.commands,
  getState: draft.getState,
  getDoc: draft.getDoc,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
};

const listed = execAudioAssetTool('list_audio', {}, ctx) as { id: string; source: string }[];
assert.deepEqual(listed, [{
  id: 'asset_voice_qa',
  name: 'Generated Voice',
  category: 'project',
  source: 'project',
  seconds: 3,
}]);
assert.deepEqual(
  execAudioAssetTool('add_audio', {}, ctx),
  { error: 'audioName is required; call list_audio to choose an asset' },
);
assert.deepEqual(
  execAudioAssetTool('add_audio', { audioName: 'asset_voice', track: 'A9' }, ctx),
  { error: 'audio track "A9" does not exist yet. Create it first with edit_track action=create json={"trackType":"audio","name":"A9"} (or omit track to place on the default audio track).' },
);
const added = execAudioAssetTool('add_audio', {
  audioName: 'asset_voice',
  track: 'A1',
  startFrame: 15,
}, ctx) as { ok: boolean; source: string };
assert.equal(added.ok, true);
assert.equal(added.source, 'project');
assert.equal(draft.getState().items[0]?.src, '/media/uploads/generated.mp3');
assert.equal(draft.getState().items[0]?.startFrame, 15);

console.log('generated/project audio placement check passed');
