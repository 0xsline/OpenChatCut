import assert from 'node:assert/strict';
import type { TimelineState } from '../editor/types';
import { fcpxmlBackgroundFillCount, timelineToFcpxml } from './fcpxml';

const state = {
  fps: 30,
  width: 1080,
  height: 1920,
  selectedId: null,
  trackOrder: ['V2', 'V1', 'A1'],
  tracks: { V2: { kind: 'video' }, V1: { kind: 'video' }, A1: { kind: 'audio' } },
  items: [
    {
      id: 'portrait', track: 'V1', kind: 'video', name: 'Portrait',
      src: '/media/uploads/portrait.mp4', startFrame: 0, durationInFrames: 90,
      width: 1920, height: 1080, backgroundFill: true,
    },
    {
      id: 'overlay', track: 'V2', kind: 'video', name: 'Overlay',
      src: '/media/uploads/overlay.mp4', startFrame: 0, durationInFrames: 30,
      width: 640, height: 360, backgroundFill: true,
    },
  ],
} as TimelineState;

assert.equal(fcpxmlBackgroundFillCount(state), 1, 'only render-active V1 fills are reported');
const xml = timelineToFcpxml(state);
assert.match(xml, /WARNING: FCPXML cannot represent OpenChatCut backgroundFill/);
assert.doesNotMatch(xml, /backgroundFill="true"/, 'unsupported private fields are not serialized as fake FCPXML');

const withoutFill = {
  ...state,
  items: state.items.map((entry) => ({ ...entry, backgroundFill: undefined })),
};
assert.equal(fcpxmlBackgroundFillCount(withoutFill), 0);
assert.doesNotMatch(timelineToFcpxml(withoutFill), /cannot represent OpenChatCut backgroundFill/);

console.log('fcpxml-background-fill.verify: loss warning and inactive export behavior ok');
