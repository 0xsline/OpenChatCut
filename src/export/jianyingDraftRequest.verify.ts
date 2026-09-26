// Runnable check: `npx tsx src/export/jianyingDraftRequest.verify.ts`
// The JianYing request carries each clip's source window, and the agent tool
// sends exactly what the export dialog sends (one builder).
import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version.js';
import type { AgentContext } from '../agent/context';
import { jianyingExportBody } from '../agent/tools/jianying-export-tool';
import type { ProjectDoc, Timeline, TimelineItem } from '../editor/types';
import { jianyingDraftPayload } from './jianyingDraftRequest';

const clip = (
  id: string,
  kind: TimelineItem['kind'],
  startFrame: number,
  durationInFrames: number,
  extra: Partial<TimelineItem> = {},
): TimelineItem => ({
  id,
  kind,
  name: id,
  src: `/media/uploads/${id}.bin`,
  track: kind === 'audio' ? 'A1' : 'V1',
  startFrame,
  durationInFrames,
  ...extra,
});

const timeline = (id: string, items: TimelineItem[], extra: Partial<Timeline> = {}): Timeline => ({
  id,
  name: id,
  order: 0,
  fps: 30,
  width: 1920,
  height: 1080,
  items,
  selectedId: null,
  ...extra,
});

const project = (timelines: Timeline[], activeTimelineId = timelines[0]!.id): ProjectDoc => ({
  version: CURRENT_PROJECT_VERSION,
  assets: [],
  mediaFolders: [],
  timelines,
  activeTimelineId,
});

// ── flat timeline: every media clip carries its source window ─────────────────
{
  const words = [
    { text: 'keep', start: 1000, end: 1500 },
    { text: 'drop', start: 1600, end: 2000 },
    { text: 'tail', start: 3000, end: 3500 },
  ];
  const flat = timeline('flat', [
    clip('trimmed', 'video', 0, 60, { srcInFrame: 900, volume: 0.5 }),
    clip('fast', 'video', 60, 30, { srcInFrame: 300, playbackRate: 2 }),
    clip('slow-from-zero', 'video', 90, 30, { playbackRate: 0.5 }),
    clip('still', 'image', 120, 15, { srcInFrame: 40, playbackRate: 3 }),
    clip('loop', 'gif', 135, 15, { srcInFrame: 12 }),
    clip('vector', 'svg', 150, 15),
    clip('title', 'text', 150, 15, { src: undefined }),
    clip('music', 'audio', 0, 90, { srcInFrame: 12 }),
    // Word-driven audio plays only its kept runs: "drop" is deleted.
    clip('voice', 'audio', 90, 30, { transcript: words, deletedWordIdx: [1] }),
  ]);
  const payload = jianyingDraftPayload(project([flat]));
  assert.equal(payload.fps, 30);
  assert.deepEqual(payload.items, [
    { kind: 'video', src: '/media/uploads/trimmed.bin', startFrame: 0, durationInFrames: 60, srcInFrame: 900, playbackRate: 1, volume: 0.5, name: 'trimmed' },
    { kind: 'video', src: '/media/uploads/fast.bin', startFrame: 60, durationInFrames: 30, srcInFrame: 300, playbackRate: 2, volume: undefined, name: 'fast' },
    { kind: 'video', src: '/media/uploads/slow-from-zero.bin', startFrame: 90, durationInFrames: 30, srcInFrame: 0, playbackRate: 0.5, volume: undefined, name: 'slow-from-zero' },
    // Stills render through <Img>: no in-point, no speed.
    { kind: 'image', src: '/media/uploads/still.bin', startFrame: 120, durationInFrames: 15, srcInFrame: 0, playbackRate: 1, volume: undefined, name: 'still' },
    { kind: 'gif', src: '/media/uploads/loop.bin', startFrame: 135, durationInFrames: 15, srcInFrame: 0, playbackRate: 1, volume: undefined, name: 'loop' },
    { kind: 'audio', src: '/media/uploads/music.bin', startFrame: 0, durationInFrames: 90, srcInFrame: 12, playbackRate: 1, volume: undefined, name: 'music' },
    // keep: source frames 30–45 at timeline 90; tail: 90–105 packed right after.
    { kind: 'audio', src: '/media/uploads/voice.bin', startFrame: 90, durationInFrames: 15, srcInFrame: 30, playbackRate: 1, volume: undefined, name: 'voice' },
    { kind: 'audio', src: '/media/uploads/voice.bin', startFrame: 105, durationInFrames: 15, srcInFrame: 90, playbackRate: 1, volume: undefined, name: 'voice' },
  ], 'svg / text are not exported; every other clip keeps its source window');
}

// ── the agent tool and the dialog share the builder ───────────────────────────
{
  const doc = project([
    timeline('other', [clip('elsewhere', 'video', 0, 30)]),
    timeline('active', [clip('shot', 'video', 15, 45, { srcInFrame: 450, playbackRate: 1.5 })]),
  ], 'active');
  const ctx = { getDoc: () => doc } as unknown as AgentContext;
  const body = jianyingExportBody({ draftName: '  Rough cut  ', draftsDir: ' ~/Drafts ' }, ctx);
  assert.deepEqual(body, { draftName: 'Rough cut', draftsDir: '~/Drafts', ...jianyingDraftPayload(doc) });
  assert.deepEqual(body.items.map((item) => [item.name, item.srcInFrame, item.playbackRate]), [['shot', 450, 1.5]],
    'the tool exports the ACTIVE timeline with its source window');
}

console.log('jianyingDraftRequest.verify: ok');
