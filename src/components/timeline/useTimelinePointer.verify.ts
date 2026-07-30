import assert from 'node:assert/strict';
import type { EditorCommands } from '../../editor/store';
import type { TimelineState } from '../../editor/types';
import type { Drag } from './timelineUtil';
import { commitTimelineDragGesture } from './useTimelinePointer';

const state: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: 'clip-a',
  selectedIds: ['clip-a'],
  items: [{
    id: 'clip-a',
    track: 'video-main',
    startFrame: 100,
    durationInFrames: 50,
    name: 'Clip A',
    kind: 'video',
    srcInFrame: 12,
  }],
};

const drag: Drag = {
  id: 'clip-a',
  mode: 'move',
  baseStart: 100,
  baseDur: 50,
  baseTrack: 'video-main',
  baseSrcIn: 12,
  startX: 0,
  deltaF: 15,
  targetTrack: 'video-main',
  snapAt: null,
};

const calls: Array<{ method: string; args: unknown[] }> = [];
const commands = new Proxy({}, {
  get: (_target, property) => (...args: unknown[]) => {
    calls.push({ method: String(property), args });
  },
}) as EditorCommands;

commitTimelineDragGesture(state, commands, drag, 'selection');
assert.equal(calls.length, 1, 'pointer release delegates one EditorCore commit');
assert.equal(calls[0]?.method, 'moveItem');
assert.deepEqual(calls[0]?.args, ['clip-a', { startFrame: 115, track: 'video-main' }]);
