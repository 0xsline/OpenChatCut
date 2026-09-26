// The capcut-cli command sequence the JianYing exporter issues, pinned argument by
// argument through the runner seam (no capcut-cli is spawned). Every clip lands at
// its timeline position and reads its own source window: add-video / add-audio,
// then `speed` when retimed, then `trim` when trimmed or retimed.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { exportJianyingDraft, type CapcutRunner, type JianyingExportClip } from './jianying-export.ts';

const DRAFTS = '/drafts/store';
const DRAFT = '/drafts/store/occ-verify';
const STORE_FLAGS = ['--jianying', '--force-write', '--drafts', DRAFTS];

type Reply = (args: string[]) => Record<string, unknown>;

/** Records each call; replies like capcut-cli 0.26 (init → draft_path, add-* → segment_id). */
function recorder(overrides: Partial<Record<string, Reply>> = {}, lengths: Record<string, number> = {}) {
  const calls: string[][] = [];
  const srt: string[] = [];
  const probed: string[] = [];
  let segments = 0;
  const probeDuration = async (file: string): Promise<number | null> => {
    probed.push(basename(file));
    return lengths[basename(file)] ?? null;
  };
  const run: CapcutRunner = async (args) => {
    calls.push(args);
    const override = overrides[args[0]!];
    if (override) return override(args);
    switch (args[0]) {
      case 'init':
        return { ok: true, name: args[1], draft_path: DRAFT };
      case 'add-video':
      case 'add-audio':
        segments += 1;
        return { ok: true, segment_id: `seg-${segments}` };
      case 'import-srt':
        srt.push(readFileSync(args[2]!, 'utf8'));
        return { ok: true };
      default:
        return { ok: true };
    }
  };
  return { calls, run, srt, probed, seams: { run, probeDuration } };
}

/** Silent 16-bit mono PCM WAV of `seconds` at 8 kHz — real media for ffprobe. */
function silentWav(seconds: number): Buffer {
  const data = Buffer.alloc(Math.round(8000 * seconds) * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const home = mkdtempSync(join(tmpdir(), 'occ-jianying-commands-'));
try {
  const master = join(home, 'master.mp4');
  const still = join(home, 'still.png');
  const voice = join(home, 'voice.wav');
  for (const file of [master, still, voice]) writeFileSync(file, 'fixture');
  const video = (startFrame: number, durationInFrames: number, extra: Partial<JianyingExportClip> = {}): JianyingExportClip => ({
    kind: 'video', src: master, startFrame, durationInFrames, name: 'shot', ...extra,
  });

  // ── the full sequence: untouched, trimmed, retimed, still, audio, captions ───
  {
    const { calls, srt, probed, seams } = recorder();
    const result = await exportJianyingDraft({
      draftName: 'occ-verify',
      draftsDir: DRAFTS,
      fps: 30,
      items: [
        video(0, 60),
        video(60, 45, { srcInFrame: 900 }),
        video(105, 30, { srcInFrame: 300, playbackRate: 2 }),
        video(135, 30, { playbackRate: 1.5 }),
        { kind: 'image', src: still, startFrame: 165, durationInFrames: 15, srcInFrame: 40, playbackRate: 3 },
        { kind: 'audio', src: voice, startFrame: 0, durationInFrames: 60, srcInFrame: 150, playbackRate: 0.5 },
        { kind: 'audio', src: voice, startFrame: 60, durationInFrames: 30 },
      ],
      captions: [{ startMs: 250, endMs: 1500, text: 'hello\nworld' }],
    }, seams);
    assert.deepEqual(result, {
      ok: true, draftName: 'occ-verify', draftPath: DRAFT, addedVideos: 5, addedAudios: 2, captions: 1, warnings: [],
    });
    assert.deepEqual(calls, [
      ['init', 'occ-verify', ...STORE_FLAGS],
      // Untrimmed at 1×: one call, exactly as before.
      ['add-video', DRAFT, master, '0', '2', ...STORE_FLAGS],
      // In-point 30 s: added with its source END (30 + 1.5) as the material length,
      // so CapCut does not clamp the in-point back to 0, then trimmed.
      ['add-video', DRAFT, master, '2', '31.5', ...STORE_FLAGS],
      ['trim', DRAFT, 'seg-2', '30', '1.5', ...STORE_FLAGS],
      // 2× from 10 s for 1 s of timeline: 2 s of source; speed before trim.
      ['add-video', DRAFT, master, '3.5', '12', ...STORE_FLAGS],
      ['speed', DRAFT, 'seg-3', '2', ...STORE_FLAGS],
      ['trim', DRAFT, 'seg-3', '10', '2', ...STORE_FLAGS],
      // Retimed from 0 still needs trim: add-video's length is the SOURCE span.
      ['add-video', DRAFT, master, '4.5', '1.5', ...STORE_FLAGS],
      ['speed', DRAFT, 'seg-4', '1.5', ...STORE_FLAGS],
      ['trim', DRAFT, 'seg-4', '0', '1.5', ...STORE_FLAGS],
      // A still ignores any in-point or rate it was sent.
      ['add-video', DRAFT, still, '5.5', '0.5', ...STORE_FLAGS],
      // Audio segments take the same speed/trim treatment.
      ['add-audio', DRAFT, voice, '0', '6', ...STORE_FLAGS],
      ['speed', DRAFT, 'seg-6', '0.5', ...STORE_FLAGS],
      ['trim', DRAFT, 'seg-6', '5', '1', ...STORE_FLAGS],
      ['add-audio', DRAFT, voice, '2', '1', ...STORE_FLAGS],
      ['import-srt', DRAFT, calls.at(-1)![2]!, ...STORE_FLAGS],
    ]);
    assert.deepEqual(srt, ['1\n00:00:00,250 --> 00:00:01,500\nhello world\n']);
    assert.deepEqual(probed, ['master.mp4', 'voice.wav'], 'each file probed once; stills never');
  }

  // ── a window never reads past the end of its file ─────────────────────────────
  {
    // Frame counts are rounded, so a clip "to the end" can overshoot its file by
    // part of a frame (voice: 10 ms, silently); more than a frame is reported.
    const { calls, seams } = recorder({}, { 'master.mp4': 31_400_000, 'voice.wav': 1_990_000 });
    const result = await exportJianyingDraft({
      draftName: 'occ-verify', draftsDir: DRAFTS, fps: 30,
      items: [
        video(0, 60),
        video(60, 45, { srcInFrame: 900 }),
        video(105, 30, { srcInFrame: 900, playbackRate: 2 }),
        video(135, 30, { srcInFrame: 1200 }),
        { kind: 'audio', src: voice, startFrame: 0, durationInFrames: 60 },
      ],
    }, seams);
    assert.deepEqual(calls.slice(1), [
      ['add-video', DRAFT, master, '0', '2', ...STORE_FLAGS],
      // 30 s + 1.5 s would pass the 31.4 s file: the window stops at its end.
      ['add-video', DRAFT, master, '2', '31.4', ...STORE_FLAGS],
      ['trim', DRAFT, 'seg-2', '30', '1.4', ...STORE_FLAGS],
      ['add-video', DRAFT, master, '3.5', '31.4', ...STORE_FLAGS],
      ['speed', DRAFT, 'seg-3', '2', ...STORE_FLAGS],
      ['trim', DRAFT, 'seg-3', '30', '1.4', ...STORE_FLAGS],
      ['add-audio', DRAFT, voice, '0', '1.99', ...STORE_FLAGS],
    ]);
    assert.equal(result.addedVideos, 3);
    assert.deepEqual(result.warnings, [
      'add-video master.mp4: runs 0.1 s past the end of the file; cut at its end',
      'add-video master.mp4: runs 0.6 s past the end of the file; cut at its end',
      'add-video master.mp4: in-point is past the end of the file',
    ]);
  }

  // ── the default probe reads the real file with the bundled ffprobe ───────────
  {
    const tone = join(home, 'tone.wav');
    writeFileSync(tone, silentWav(0.5));
    const request = {
      draftName: 'occ-verify', draftsDir: DRAFTS, fps: 30,
      items: [
        { kind: 'image', src: still, startFrame: 0, durationInFrames: 30 },
        { kind: 'audio', src: tone, startFrame: 0, durationInFrames: 20 },
      ],
    };
    const unprobed = recorder();
    await exportJianyingDraft(request, unprobed.seams);
    assert.deepEqual(unprobed.calls.at(-1), ['add-audio', DRAFT, tone, '0', '0.666667', ...STORE_FLAGS],
      'without a length the request is passed through');
    const probed = recorder();
    const result = await exportJianyingDraft(request, { run: probed.run });
    assert.deepEqual(probed.calls.at(-1), ['add-audio', DRAFT, tone, '0', '0.5', ...STORE_FLAGS],
      '0.667 s of timeline over a 0.5 s file stops at 0.5 s');
    assert.deepEqual(result.warnings, ['add-audio tone.wav: runs 0.166667 s past the end of the file; cut at its end']);
  }

  // ── frame boundaries round once, so neighbours stay edge to edge ─────────────
  {
    const { calls, seams } = recorder();
    await exportJianyingDraft({ draftName: 'occ-verify', draftsDir: DRAFTS, fps: 30, items: [video(1, 1), video(2, 1)] }, seams);
    assert.deepEqual(calls.slice(1).map((args) => args.slice(3, 5)), [['0.033333', '0.033334'], ['0.066667', '0.033333']],
      'the first clip ends exactly where the second starts (0.066667 s)');
  }

  // ── a capcut-cli without segment ids cannot be trimmed: say so, do not guess ─
  {
    const { calls, seams } = recorder({ 'add-video': () => ({ ok: true }) });
    const result = await exportJianyingDraft({ draftName: 'occ-verify', draftsDir: DRAFTS, fps: 30, items: [video(0, 30, { srcInFrame: 60 })] }, seams);
    assert.equal(result.ok, true);
    assert.equal(result.addedVideos, 1);
    assert.deepEqual(result.warnings, ['add-video master.mp4: capcut-cli returned no segment id; the clip plays its source from 0']);
    assert.deepEqual(calls.map((args) => args[0]), ['init', 'add-video'], 'no speed/trim without a segment id');
  }

  // ── a failed speed skips the trim that would rescale against the wrong rate ──
  {
    const { calls, seams } = recorder({ speed: () => ({ ok: false, error: 'Segment not found: seg-1' }) });
    const result = await exportJianyingDraft({ draftName: 'occ-verify', draftsDir: DRAFTS, fps: 30, items: [video(0, 30, { playbackRate: 2 })] }, seams);
    assert.deepEqual(result.warnings, ['speed master.mp4: Segment not found: seg-1']);
    assert.deepEqual(calls.map((args) => args[0]), ['init', 'add-video', 'speed']);
  }

  // ── untrusted numbers fall back instead of reaching capcut-cli as NaN ────────
  {
    const { calls, seams } = recorder();
    const result = await exportJianyingDraft({
      draftName: 'occ-verify', draftsDir: DRAFTS, fps: 30,
      items: [
        video(0, 30, { srcInFrame: -5, playbackRate: Number.NaN }),
        video(30, 30, { playbackRate: 0 }),
        // A sub-microsecond sliver is dropped: without a length add-video would take the whole file.
        video(60, 1e-9),
        video(60, Number.NaN),
      ],
    }, seams);
    assert.deepEqual(calls.slice(1), [
      ['add-video', DRAFT, master, '0', '1', ...STORE_FLAGS],
      ['add-video', DRAFT, master, '1', '1', ...STORE_FLAGS],
    ]);
    assert.deepEqual([result.addedVideos, result.warnings], [2, []]);
  }

  // ── init failure and empty timelines stop before touching clips ──────────────
  {
    const { calls, seams } = recorder({ init: () => ({ ok: false, error: 'Draft already exists' }) });
    const result = await exportJianyingDraft({ draftName: 'occ-verify', draftsDir: DRAFTS, fps: 30, items: [video(0, 30)] }, seams);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Draft already exists');
    assert.deepEqual(calls.map((args) => args[0]), ['init']);
  }
  {
    const { calls, seams } = recorder();
    const result = await exportJianyingDraft({ fps: 30, items: [{ kind: 'audio', src: voice, startFrame: 0, durationInFrames: 30 }] }, seams);
    assert.equal(result.error, 'timeline has no video clips to export');
    assert.deepEqual(calls, []);
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log('jianying-export command sequence checks passed');
