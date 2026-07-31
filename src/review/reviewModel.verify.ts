import assert from 'node:assert/strict';
import type { TimelineItem, TimelineState } from '../editor/types';
import {
  appendReviewReply,
  createReviewComment,
  normalizeReviewComments,
  reviewAnchor,
  setReviewResolved,
} from './reviewModel';

const item: TimelineItem = {
  id: 'clip-a',
  track: 'video-main',
  startFrame: 30,
  durationInFrames: 60,
  name: 'Interview',
  kind: 'video',
  src: '/media/uploads/a.mp4',
  srcInFrame: 90,
  playbackRate: 2,
};
const state: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  items: [item],
  selectedId: item.id,
  assets: [{
    id: 'asset-a',
    name: 'Interview',
    kind: 'video',
    src: item.src!,
    durationInFrames: 900,
  }],
};

const anchored = reviewAnchor('timeline-a', 45, state, item);
assert.deepEqual(anchored, {
  timelineId: 'timeline-a',
  frame: 45,
  itemId: 'clip-a',
  assetId: 'asset-a',
  sourceFrame: 120,
});
assert.deepEqual(
  reviewAnchor('timeline-a', 10, state, item),
  { timelineId: 'timeline-a', frame: 10 },
  'a selected clip outside the playhead must not receive a misleading source anchor',
);

const comment = createReviewComment(anchored, '  Tighten this cut.  ', 100, 'comment-a');
assert.equal(comment.text, 'Tighten this cut.');
const replied = appendReviewReply([comment], comment.id, 'Done.', 110, 'reply-a');
assert.equal(replied[0].replies[0].text, 'Done.');
assert.equal(comment.replies.length, 0, 'reply updates must be immutable');
assert.equal(setReviewResolved(replied, comment.id, true)[0].resolved, true);
assert.deepEqual(normalizeReviewComments([comment, { broken: true }]), [comment]);
assert.throws(() => createReviewComment(anchored, '   '), /不能为空/);

console.log('reviewModel.verify: ok');
