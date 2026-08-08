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
      width: 1920, height: 1080, backgroundFill: true, backgroundFillStrength: 73,
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
assert.match(xml, /backgroundFill settings are preserved as OpenChatCut metadata/);
assert.match(xml, /key="com\.openchatcut\.backgroundFillStrength" value="73"/,
  'the exact percentage survives in portable custom metadata');
assert.equal((xml.match(/key="com\.openchatcut\.backgroundFill"/g) ?? []).length, 1,
  'inactive overlay fills do not emit misleading metadata');
assert.doesNotMatch(xml, /backgroundFill="true"/, 'private fields are not serialized as fake attributes');

const withoutFill = {
  ...state,
  items: state.items.map((entry) => ({ ...entry, backgroundFill: undefined })),
};
assert.equal(fcpxmlBackgroundFillCount(withoutFill), 0);
assert.doesNotMatch(timelineToFcpxml(withoutFill), /backgroundFill settings are preserved/);

console.log('fcpxml-background-fill.verify: metadata preservation, warning, and inactive behavior ok');
