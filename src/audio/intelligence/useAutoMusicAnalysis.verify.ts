import assert from 'node:assert/strict';
import type { MediaAsset } from '../../editor/types';
import { changedMusicAnalysisAssets } from './useAutoMusicAnalysis';

function asset(
  id: string,
  kind: MediaAsset['kind'],
  src: string,
  sourceRevision: string,
): MediaAsset {
  return {
    id,
    kind,
    src,
    sourceRevision,
    name: `${id}.wav`,
    durationInFrames: 30,
  } as MediaAsset;
}

const initialAudio = asset('audio', 'audio', '/media/uploads/audio.wav', 'rev-1');
const initialVideo = asset('video', 'video', '/media/uploads/video.mp4', 'rev-1');
const image = asset('image', 'image', '/media/uploads/image.png', 'rev-1');
const initial = changedMusicAnalysisAssets(new Map(), [initialAudio, initialVideo, image]);
assert.deepEqual(initial.changed.map(({ id }) => id), ['audio', 'video']);

const stable = changedMusicAnalysisAssets(initial.current, [initialAudio, initialVideo, image]);
assert.deepEqual(stable.changed, [], 'unchanged canonical assets must not enqueue again');

const relinkedVideo = { ...initialVideo, src: '/media/uploads/video-v2.mp4', sourceRevision: 'rev-2' };
const relinked = changedMusicAnalysisAssets(stable.current, [initialAudio, relinkedVideo, image]);
assert.deepEqual(relinked.changed.map(({ id }) => id), ['video']);

const placeholder = asset('placeholder', 'audio', 'blob:temporary', 'rev-1');
const hidden = changedMusicAnalysisAssets(relinked.current, [initialAudio, relinkedVideo, placeholder]);
assert.deepEqual(hidden.changed, [], 'blob placeholders must wait for canonical relink');

const readyPlaceholder = { ...placeholder, src: '/media/uploads/ready.wav', sourceRevision: 'rev-2' };
const ready = changedMusicAnalysisAssets(hidden.current, [initialAudio, relinkedVideo, readyPlaceholder]);
assert.deepEqual(ready.changed.map(({ id }) => id), ['placeholder']);

console.log('useAutoMusicAnalysis.verify: ok');
