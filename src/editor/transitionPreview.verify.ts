import assert from 'node:assert/strict';
import type { TimelineItem } from './types';
import { continuousVideoAudioGroups } from './transitionAudio';
import { previewTransitionType } from './transitionPreview';

assert.equal(previewTransitionType('cross-dissolve'), 'cross-dissolve');
assert.equal(previewTransitionType('clean-line-wipe'), 'soft-wipe');
assert.equal(previewTransitionType('impact-shake'), 'whip-pan');
assert.equal(previewTransitionType('page-curl'), 'soft-wipe');
assert.equal(previewTransitionType('custom-shader'), 'cross-dissolve');

const outgoing = { id: 'out', kind: 'video', track: 'v1', src: '/x.mp4', startFrame: 0, durationInFrames: 30, srcInFrame: 0 } as unknown as TimelineItem;
const incoming = { id: 'in', kind: 'video', track: 'v1', src: '/x.mp4', startFrame: 30, durationInFrames: 30, srcInFrame: 30 } as unknown as TimelineItem;
assert.deepEqual(continuousVideoAudioGroups([incoming, outgoing]).map((group) => group.map((item) => item.id)), [['out', 'in']]);
assert.deepEqual(continuousVideoAudioGroups([outgoing, { ...incoming, srcInFrame: 31 }]), []);
assert.deepEqual(continuousVideoAudioGroups([outgoing, incoming], [{
  type: 'audio-cross-fade', outgoingItemId: 'out', incomingItemId: 'in', durationInFrames: 5,
}] as never), []);

console.log('transitionPreview.verify: ok');
