// Runnable check: `npx tsx src/agent/markers-tools.check.ts`.
// Asserts manage_markers exec dispatches to the store commands correctly and
// validates input (no fromFrame / item without itemId / unknown id).
import assert from 'node:assert';
import { makeDraft } from '../../editor/store';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import type { Marker, TimelineState } from '../../editor/types';
import type { TranscriptWord } from '../../transcript/types';
import { execMarkersTool, MARKERS_TOOL_SCHEMAS } from './markers-tools';

interface Call { fn: string; args: unknown[]; }

function makeCtx(markers: Marker[]): { ctx: AgentContext; calls: Call[] } {
  const calls: Call[] = [];
  let n = 0;
  const commands = {
    addMarker: (...args: unknown[]) => { calls.push({ fn: 'addMarker', args }); return `mk_${++n}`; },
    updateMarker: (...args: unknown[]) => { calls.push({ fn: 'updateMarker', args }); },
    removeMarker: (...args: unknown[]) => { calls.push({ fn: 'removeMarker', args }); },
  };
  const ctx = { getState: () => ({ markers }), commands } as unknown as AgentContext;
  return { ctx, calls };
}

const existing: Marker[] = [{ id: 'mk_a', scope: 'project', fromFrame: 30, durationFrames: 0, note: 'hi', color: 'blue' }];

// list
{
  const { ctx } = makeCtx(existing);
  const r = execMarkersTool('manage_markers', { action: 'list' }, ctx) as { markers: unknown[] };
  assert.equal(r.markers.length, 1, 'list returns existing markers');
}

// create single
{
  const { ctx, calls } = makeCtx([]);
  const r = execMarkersTool('manage_markers', { action: 'create', fromFrame: 90, note: 'drop', color: 'red' }, ctx) as { created: string[] };
  assert.deepEqual(r.created, ['mk_1'], 'create returns new id');
  assert.equal(calls[0].fn, 'addMarker');
  assert.equal((calls[0].args[0] as number), 90, 'fromFrame passed');
  assert.equal((calls[0].args[1] as { color: string }).color, 'red', 'color passed');
}

// create batch
{
  const { ctx, calls } = makeCtx([]);
  const r = execMarkersTool('manage_markers', { action: 'create', markers: [{ fromFrame: 1 }, { fromFrame: 2 }] }, ctx) as { created: string[] };
  assert.equal(r.created.length, 2, 'batch creates two');
  assert.equal(calls.length, 2);
}

// create validation: missing fromFrame
{
  const { ctx } = makeCtx([]);
  const r = execMarkersTool('manage_markers', { action: 'create', note: 'x' }, ctx) as { error?: string };
  assert.ok(r.error, 'missing fromFrame errors');
}

// create validation: item scope without itemId
{
  const { ctx } = makeCtx([]);
  const r = execMarkersTool('manage_markers', { action: 'create', fromFrame: 5, scope: 'item' }, ctx) as { error?: string };
  assert.ok(r.error, 'item scope needs itemId');
}

// update existing
{
  const { ctx, calls } = makeCtx(existing);
  const r = execMarkersTool('manage_markers', { action: 'update', markerId: 'mk_a', note: 'changed' }, ctx) as { ok?: boolean };
  assert.ok(r.ok, 'update ok');
  assert.equal(calls[0].fn, 'updateMarker');
  assert.deepEqual(calls[0].args[1], { note: 'changed' }, 'only whitelisted patch');
}

// update unknown id
{
  const { ctx } = makeCtx(existing);
  const r = execMarkersTool('manage_markers', { action: 'update', markerId: 'nope', note: 'x' }, ctx) as { error?: string };
  assert.ok(r.error, 'unknown id errors');
}

// delete existing / unknown
{
  const { ctx, calls } = makeCtx(existing);
  assert.ok((execMarkersTool('manage_markers', { action: 'delete', markerId: 'mk_a' }, ctx) as { ok?: boolean }).ok);
  assert.equal(calls[0].fn, 'removeMarker');
  assert.ok((execMarkersTool('manage_markers', { action: 'delete', markerId: 'ghost' }, ctx) as { error?: string }).error);
}

// ── transcriptSegments(源):[sN] 段号建 marker,与 read_script 同一套编号 ──
// A1: "hello world." + "nice day."(两段);V1: "hello again."(一段,startFrame 100)
{
  const schema = MARKERS_TOOL_SCHEMAS[0]!.input_schema as { properties: Record<string, unknown> };
  for (const f of ['transcriptSegments', 'transcriptTrack', 'notePrefix']) assert.ok(f in schema.properties, `schema has ${f}`);

  const w = (text: string, s: number, e: number): TranscriptWord => ({ text, start: s, end: e, speaker: 'A' });
  const state: TimelineState = {
    fps: 30, width: 1920, height: 1080, selectedId: null,
    items: [
      { id: 'voA', track: 'A1', startFrame: 0, durationInFrames: 72, name: 'voA', kind: 'audio', src: '/a.mp3',
        transcript: [w('hello', 0, 400), w('world.', 400, 1000), w('nice', 1500, 1900), w('day.', 1900, 2400)] },
      { id: 'voB', track: 'V1', startFrame: 100, durationInFrames: 24, name: 'voB', kind: 'video', src: '/b.mp4',
        transcript: [w('hello', 0, 300), w('again.', 300, 800)] },
    ],
  };
  const mk = () => {
    const d = makeDraft(docFromTimeline(state));
    const c: AgentContext = { commands: d.commands, getState: d.getState, getDoc: d.getDoc, getCreativeMode: () => null, templates: [], audio: [] };
    return { d, c };
  };
  const markersOf = (d: ReturnType<typeof makeDraft>) => d.getState().markers ?? [];

  // 单段 + notePrefix:s2 = "nice day." → fromFrame 45(=1.5s@30fps),covering 段长 27f
  {
    const { d, c } = mk();
    const r = execMarkersTool('manage_markers', { action: 'create', transcriptSegments: '2', transcriptTrack: 'A1', notePrefix: 'TODO' }, c) as { ok?: boolean; created?: string[] };
    assert.ok(r.ok, 'create via transcriptSegments succeeds without fromFrame/note');
    const m = markersOf(d)[0]!;
    assert.equal(m.fromFrame, 45, 'fromFrame derived from the segment\'s first word (词级时间戳)');
    assert.equal(m.durationFrames, 27, 'duration spans the segment');
    assert.equal(m.note, 'TODO: nice day.', 'note = notePrefix + copied read_script text');
  }

  // 段范围 "1-2":跨两段,note 按段顺序拼接
  {
    const { d, c } = mk();
    execMarkersTool('manage_markers', { action: 'create', transcriptSegments: '1-2', transcriptTrack: 'A1' }, c);
    const m = markersOf(d)[0]!;
    assert.equal(m.fromFrame, 0);
    assert.equal(m.durationFrames, 72, 'range covers seg1 start → seg2 end');
    assert.equal(m.note, 'hello world. nice day.', 'note copies both segments');
  }

  // 歧义:两个转写区域都有 s1 → 明确报错点名 transcriptTrack;带 track 过滤则命中 V1 clip
  {
    const { d, c } = mk();
    const amb = execMarkersTool('manage_markers', { action: 'create', transcriptSegments: '1' }, c) as { error?: string };
    assert.ok(amb.error?.includes('transcriptTrack'), 'ambiguous [s1] across regions errors with guidance');
    const r = execMarkersTool('manage_markers', { action: 'create', transcriptSegments: '1', transcriptTrack: 'V1' }, c) as { ok?: boolean };
    assert.ok(r.ok);
    const m = markersOf(d)[0]!;
    assert.equal(m.fromFrame, 100, 'V1 clip segment anchors at its startFrame');
    assert.equal(m.durationFrames, 24);
    assert.equal(m.note, 'hello again.');
  }

  // 显式 fromFrame / note 优先于派生值(源:"unless you pass fromFrame explicitly")
  {
    const { d, c } = mk();
    execMarkersTool('manage_markers', { action: 'create', transcriptSegments: '2', transcriptTrack: 'A1', fromFrame: 999, note: '手写' }, c);
    const m = markersOf(d)[0]!;
    assert.equal(m.fromFrame, 999, 'explicit fromFrame wins');
    assert.equal(m.note, '手写', 'explicit note wins');
  }

  // 批量 markers[]:每项可独立用 transcriptSegments 或 fromFrame
  {
    const { d, c } = mk();
    const r = execMarkersTool('manage_markers', { action: 'create', markers: [
      { transcriptSegments: '1', transcriptTrack: 'V1' },
      { fromFrame: 5, note: 'plain' },
    ] }, c) as { created?: string[] };
    assert.equal(r.created?.length, 2, 'batch mixes segment-derived and frame-anchored entries');
    assert.equal(markersOf(d).length, 2);
  }

  // 错误路径:未知段号 / 非法 spec / 未知轨,都不落任何 marker
  {
    const { d, c } = mk();
    assert.ok((execMarkersTool('manage_markers', { action: 'create', transcriptSegments: '9', transcriptTrack: 'A1' }, c) as { error?: string }).error, 'unknown segment errors');
    assert.ok((execMarkersTool('manage_markers', { action: 'create', transcriptSegments: 'x-y' }, c) as { error?: string }).error, 'malformed spec errors');
    assert.ok((execMarkersTool('manage_markers', { action: 'create', transcriptSegments: '1', transcriptTrack: 'A9' }, c) as { error?: string }).error, 'unknown track errors');
    assert.equal(markersOf(d).length, 0, 'no marker placed on any error path');
  }
}

// eslint-disable-next-line no-console
console.log('markers-tools.check: ok');
