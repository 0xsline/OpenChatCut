// Split motion-graphic pieces play their window of ONE animation: npx tsx src/editor/motionGraphicTime.verify.ts
import assert from 'node:assert/strict';
import { motionGraphicTime } from './motionGraphicTime';

// useCurrentFrame() = timeline position - (cumulatedFrom + relativeFrom). Shifting relativeFrom back by
// the in-point makes a piece that starts on the timeline at its cut read the frame of the whole design.
const parent = { relativeFrom: 4674, durationInFrames: 190 };
const second = motionGraphicTime(parent, { srcInFrame: 160, durationInFrames: 190, designDurationInFrames: 868 })!;
const frameAt = (timelineFrame: number) => timelineFrame - second.relativeFrom;
assert.equal(frameAt(4674), 160, 'at its first timeline frame the second piece shows design frame 160, not 0');
assert.equal(frameAt(4863), 349, 'and it runs on through the design');
assert.equal(second.durationInFrames, 868, 'the template sees the whole design, so its exit fade is at the real end');

// The first piece starts at the beginning but still sees the full length: no fade-out at its cut.
const first = motionGraphicTime({ relativeFrom: 4514, durationInFrames: 160 }, { srcInFrame: 0, durationInFrames: 160, designDurationInFrames: 868 })!;
assert.equal(first.relativeFrom, 4514, 'no shift for the first piece');
assert.equal(first.durationInFrames, 868, 'but it knows the animation carries on past its end');

// Transition handles lengthen the parent sequence; that extra is kept on top of the design.
const handled = motionGraphicTime({ relativeFrom: 100, durationInFrames: 200 }, { srcInFrame: 50, durationInFrames: 190, designDurationInFrames: 868 })!;
assert.equal(handled.durationInFrames, 878, 'a 10-frame handle stays');

// An unsplit motion graphic is left exactly as it always was.
assert.equal(motionGraphicTime(parent, { durationInFrames: 190 }), null, 'no design length → play from frame 0 as before');
assert.equal(motionGraphicTime(parent, { srcInFrame: 30, durationInFrames: 190 }), null,
  'an old trimmed clip without a design length is not suddenly shifted');

console.log('motionGraphicTime.verify: OK');
