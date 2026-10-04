// Runnable check: `npx tsx src/export/premiereBake.verify.ts`.
// The export baker must render isolated transparent ProRes layers, attach only
// successfully produced files, and stop cleanly on errors or cancellation.
import assert from 'node:assert/strict';
import type { TimelineItem, TimelineState } from '../editor/types';
import { planPremiereExport, premiereBakeState } from './premiereBakePlan';
import { renderPremiereBakeJobs } from './premiereBake';
import type { PremiereExportPlan } from './premiereTypes';

function state(items: TimelineItem[], extra: Partial<TimelineState> = {}): TimelineState {
  return {
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    items,
    ...extra,
  };
}

const item = (
  id: string,
  track: string,
  kind: TimelineItem['kind'],
  extra: Partial<TimelineItem> = {},
): TimelineItem => ({
  id,
  track,
  kind,
  startFrame: 42,
  durationInFrames: 60,
  name: id,
  src: `/media/uploads/${id}.mov`,
  ...extra,
});

type FetchCall = { input: RequestInfo | URL; init?: RequestInit };

// ── Planner capability boundaries: preserve native tracks/audio where safe ──
{
  const hidden = item('hidden-featured', 'V1', 'video', {
    effects: [{ id: 'fx-hidden', assetId: 'builtin:fx-glow' }],
    denoisedSrc: '/media/uploads/hidden-clean.wav',
  });
  const muted = item('muted-denoised', 'A1', 'audio', { denoisedSrc: '/media/uploads/muted-clean.wav' });
  const disabledPlan = planPremiereExport(state([hidden, muted], {
    tracks: { V1: { kind: 'video', hidden: true }, A1: { kind: 'audio', muted: true } },
  }));
  assert.deepEqual(disabledPlan.bakeJobs.map(({ itemId, kind }) => [itemId, kind]), [
    [hidden.id, 'visual'], [hidden.id, 'audio'], [muted.id, 'audio'],
  ], 'unsupported content on disabled tracks is baked for later unhide/unmute while the final track remains disabled');
  assert.equal(disabledPlan.issues.some((issue) => issue.severity === 'error'), false);
  const ordinaryDisabled = planPremiereExport(state([
    item('hidden-ordinary', 'V1', 'video'),
    item('muted-ordinary', 'A1', 'audio'),
  ], { tracks: { V1: { kind: 'video', hidden: true }, A1: { kind: 'audio', muted: true } } }));
  assert.deepEqual(ordinaryDisabled.bakeJobs, [], 'hidden/muted state alone does not trigger a bake');
  assert.deepEqual(ordinaryDisabled.issues, [], 'ordinary disabled tracks are preserved by the native enabled flags');

  const mutedVideo = item('muted-video', 'V1', 'video', {
    effects: [{ id: 'fx-muted', assetId: 'builtin:fx-glow' }],
    denoisedSrc: '/media/uploads/muted-video-clean.wav',
  });
  const mutedVideoPlan = planPremiereExport(state([mutedVideo], { tracks: { V1: { kind: 'video', muted: true } } }));
  assert.deepEqual(mutedVideoPlan.bakeJobs.map(({ itemId, kind }) => [itemId, kind]), [
    ['muted-video', 'visual'], ['muted-video', 'audio'],
  ], 'unsupported picture and sound on a muted track are preserved for a later unmute');

  for (const playbackRate of [0.5, 1, 1.25, 2]) {
    const nativeSpeed = planPremiereExport(state([
      item(`speed-${playbackRate}`, 'V1', 'video', { playbackRate }),
    ]));
    assert.deepEqual(nativeSpeed.bakeJobs, [], `${playbackRate}x positive playback is represented natively`);
    assert.equal(nativeSpeed.issues.some((issue) => issue.severity === 'error'), false,
      `${playbackRate}x positive playback is not rejected`);
  }
  for (const playbackRate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const invalidId = `invalid-speed-${String(playbackRate)}`;
    const invalid = planPremiereExport(state([item(invalidId, 'V1', 'video', { playbackRate })]));
    assert.equal(invalid.issues.some((issue) => issue.severity === 'error'
      && issue.itemIds.includes(invalidId)), true, `${String(playbackRate)}x speed is a visible planner error`);
  }

  const unsupportedVisuals: Array<[string, Partial<TimelineItem>]> = [
    ['position', { transform: { x: 12 } }],
    ['opacity', { transform: { opacity: 0.7 } }],
    ['crop', { transform: { crop: { left: 0.1 } } }],
    ['visual-keyframes', { keyframes: { opacity: [{ frame: 0, value: 0 }, { frame: 30, value: 1 }] } }],
    ['filter', { filters: { brightness: 1.2 } }],
    ['background-fill', { backgroundFill: true }],
  ];
  for (const [label, fields] of unsupportedVisuals) {
    const visualId = `bake-${label}`;
    const plan = planPremiereExport(state([item(visualId, 'V1', 'video', fields)]));
    assert.deepEqual(plan.bakeJobs.map(({ itemId, kind }) => [itemId, kind]), [[visualId, 'visual']],
      `${label} is not silently dropped by the native visual mapping`);
    assert.equal(plan.issues.some((issue) => issue.severity === 'error'), false,
      `${label} can be preserved with an item-scoped visual bake`);
  }

  const nativeAudioItems = [
    item('static-volume-and-fades', 'A1', 'audio', {
      startFrame: 0, durationInFrames: 30, volume: 0.4, fadeInFrames: 6, fadeOutFrames: 9,
    }),
    item('linear-volume-curve', 'A1', 'audio', {
      startFrame: 30, durationInFrames: 30,
      keyframes: { volume: [{ frame: 0, value: 0.2 }, { frame: 30, value: 0.8, easing: 'linear' }] },
    }),
    item('default-volume-curve', 'A1', 'audio', {
      startFrame: 60, durationInFrames: 30,
      keyframes: { volume: [{ frame: 0, value: 0.2 }, { frame: 30, value: 0.8 }] },
    }),
    item('operational-transcript', 'A1', 'audio', {
      startFrame: 90, durationInFrames: 30,
      transcript: [
        { text: 'keep', start: 0, end: 500 },
        { text: 'remove', start: 500, end: 1000 },
      ],
      deletedWordIdx: [1],
    }),
  ];
  const nativeAudioPlan = planPremiereExport(state(nativeAudioItems));
  assert.deepEqual(nativeAudioPlan.bakeJobs, [],
    'static volume/fades, linear volume curves, and transcript cuts retain native audio mappings');
  assert.equal(nativeAudioPlan.issues.some((issue) => issue.severity === 'error'), false);

  const audioBakeCases: Array<[string, Partial<TimelineItem>]> = [
    ['nonlinear-volume', { keyframes: { volume: [{ frame: 0, value: 0.1, easing: 'easeIn' }, { frame: 30, value: 0.8 }] } }],
    ['volume-plus-fade', { keyframes: { volume: [{ frame: 0, value: 0.1 }, { frame: 30, value: 0.8 }] }, fadeInFrames: 4 }],
    ['denoised-audio', { denoisedSrc: '/media/uploads/clean.wav' }],
  ];
  for (const [label, fields] of audioBakeCases) {
    const audioId = `bake-${label}`;
    const plan = planPremiereExport(state([item(audioId, 'A1', 'audio', fields)]));
    assert.deepEqual(plan.bakeJobs.map(({ itemId, kind }) => [itemId, kind]), [[audioId, 'audio']],
      `${label} gets an audio bake instead of losing the processing`);
    assert.equal(plan.issues.some((issue) => issue.severity === 'error'), false,
      `${label} is representable by an item-scoped audio bake`);
  }

  const adjacent = planPremiereExport(state([
    item('adjacent-left', 'V1', 'video', { startFrame: 0, durationInFrames: 30 }),
    item('adjacent-right', 'V1', 'video', { startFrame: 30, durationInFrames: 30 }),
  ]));
  assert.equal(adjacent.issues.some((issue) => issue.severity === 'error'), false,
    'adjacent same-track clips remain valid');
  for (const [label, rightStart, rightDuration] of [
    ['partial', 30, 60],
    ['nested', 20, 20],
  ] as const) {
    const left = item(`${label}-left`, 'V1', 'video', { startFrame: 0, durationInFrames: 90 });
    const right = item(`${label}-right`, 'V1', 'video', { startFrame: rightStart, durationInFrames: rightDuration });
    const plan = planPremiereExport(state([left, right]));
    assert.equal(plan.issues.some((issue) => issue.severity === 'error'
      && issue.itemIds.includes(left.id) && issue.itemIds.includes(right.id)), true,
    `${label} same-track overlap is reported instead of producing ambiguous XMEML compositing`);
  }

  const duplicate = item('duplicate-id', 'V1', 'video');
  const duplicatePlan = planPremiereExport(state([
    duplicate,
    { ...duplicate, track: 'V2', startFrame: 100 },
  ]));
  assert.equal(duplicatePlan.issues.some((issue) => issue.severity === 'error'), true,
    'duplicate item IDs are rejected before stable bake IDs can collide');
  for (const srcInFrame of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const invalid = item(`invalid-source-in-${String(srcInFrame)}`, 'V1', 'video', { srcInFrame });
    assert.equal(planPremiereExport(state([invalid])).issues.some((issue) => issue.severity === 'error'), true,
      `${String(srcInFrame)} source in-point is rejected instead of silently changing trim`);
  }
}

// ── Bake isolation preserves operational cuts while muting the correct stream ──
{
  const transcript = [
    { text: 'keep', start: 0, end: 500 },
    { text: 'cut', start: 500, end: 1000 },
  ];
  const videoWithTranscript = item('video-transcript', 'V1', 'video', {
    transcript,
    deletedWordIdx: [1],
    keyframes: {
      opacity: [{ frame: 0, value: 0.5 }, { frame: 30, value: 1 }],
      volume: [{ frame: 0, value: 1, easing: 'easeIn' }, { frame: 30, value: 0.2 }],
    },
  });
  const videoState = state([videoWithTranscript]);
  const isolatedVideoAudio = premiereBakeState(videoState, videoWithTranscript, 'audio').items[0]!;
  assert.equal(isolatedVideoAudio.kind, 'audio');
  assert.equal(isolatedVideoAudio.transcript, undefined, 'video companion audio bake ignores speech edits applied to the picture timeline');
  assert.equal(isolatedVideoAudio.deletedWordIdx, undefined, 'video companion audio bake clears transcript delete indices');
  assert.equal(isolatedVideoAudio.keyframes?.opacity, undefined, 'video companion audio bake clears visual keyframes');
  assert.deepEqual(isolatedVideoAudio.keyframes?.volume, videoWithTranscript.keyframes?.volume,
    'video companion audio bake retains its needed volume shaping');

  const editedAudio = item('edited-audio-transcript', 'A1', 'audio', {
    transcript,
    deletedWordIdx: [1],
    keyframes: { volume: [{ frame: 0, value: 1, easing: 'easeIn' }, { frame: 30, value: 0.2 }] },
  });
  const isolatedAudio = premiereBakeState(state([editedAudio]), editedAudio, 'audio').items[0]!;
  assert.deepEqual(isolatedAudio.transcript, transcript, 'true audio bakes preserve operational transcript cuts');
  assert.deepEqual(isolatedAudio.deletedWordIdx, [1], 'true audio bakes preserve the selected word deletions');

  const keyed = item('visual-keyed-volume', 'V1', 'video', {
    keyframes: { volume: [{ frame: 0, value: 1 }, { frame: 30, value: 0.1 }] },
  });
  const visualState = premiereBakeState(state([keyed]), keyed, 'visual');
  assert.equal(visualState.items[0]!.volume, 0, 'visual bake mutes embedded audio at the item level');
  assert.equal(visualState.items[0]!.keyframes?.volume, undefined,
    'visual bake removes volume keyframes that could override its explicit mute');
}

// ── Disabled source tracks are enabled only inside a forced isolated render ──
{
  const hiddenVisual = item('hidden-visual-bake', 'V1', 'video', {
    effects: [{ id: 'fx-hidden', assetId: 'builtin:fx-glow' }],
  });
  const mutedAudio = item('muted-audio-bake', 'A1', 'audio', { denoisedSrc: '/media/uploads/muted-clean.wav' });
  const plan: PremiereExportPlan = {
    bakeJobs: [
      { itemId: hiddenVisual.id, kind: 'visual', filename: 'hidden-visual.mov', reasons: ['fixture'] },
      { itemId: mutedAudio.id, kind: 'audio', filename: 'muted-audio.wav', reasons: ['fixture'] },
    ],
    issues: [],
  };
  const source = state([hiddenVisual, mutedAudio], {
    tracks: { V1: { kind: 'video', hidden: true }, A1: { kind: 'audio', muted: true } },
  });
  const oldFetch = globalThis.fetch;
  const posted: TimelineState[] = [];
  globalThis.fetch = (async (_input, init) => {
    posted.push((JSON.parse(String(init?.body)) as { state: TimelineState }).state);
    return Response.json({ path: `/media/uploads/${posted.length === 1 ? 'hidden-render.mov' : 'muted-render.wav'}` });
  }) as typeof fetch;
  try {
    const rendered = await renderPremiereBakeJobs(source, plan);
    assert.deepEqual([...rendered.media.entries()], [
      [hiddenVisual.id, { visualSrc: '/media/uploads/hidden-render.mov' }],
      [mutedAudio.id, { audioSrc: '/media/uploads/muted-render.wav' }],
    ]);
    assert.equal(posted[0]!.tracks?.V1?.hidden, false, 'a hidden source picture is visible in its isolated render state');
    assert.equal(posted[1]!.tracks?.A1?.muted, false, 'a muted source sound is audible in its isolated render state');
  } finally {
    globalThis.fetch = oldFetch;
  }
}

// ── Visual bake: one isolated source, stripped timeline overlays, transparent ProRes payload ──
{
  const selected = item('complicated', 'V1', 'video', {
    startFrame: 90,
    durationInFrames: 48,
    effects: [{ id: 'glow', assetId: 'builtin:fx-glow' }],
    volume: 0.5,
  });
  const unrelated = item('unrelated', 'A1', 'audio');
  const source = state([selected, unrelated], {
    tracks: {
      V1: { kind: 'video', captions: null, locked: true },
      A1: { kind: 'audio', muted: true },
    },
    trackOrder: ['V1', 'A1'],
    transitions: [],
    markers: [{ id: 'marker', scope: 'project', fromFrame: 30, durationFrames: 0, note: 'remove from isolated render', color: 'blue' }],
    captions: null,
    captionsHidden: false,
    watermark: { enabled: false, text: 'hidden watermark text', position: 'br', opacity: 0.5 },
  });
  const plan = planPremiereExport(source);
  assert.equal(plan.issues.some((issue) => issue.severity === 'error'), false, 'clip-local WebGL effects can be selectively baked');
  assert.deepEqual(plan.bakeJobs.map(({ itemId, kind }) => [itemId, kind]), [['complicated', 'visual']]);

  const calls: FetchCall[] = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ path: '/media/uploads/complicated-visual.mov' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  const progress: Array<[string, number, number]> = [];
  try {
    const rendered = await renderPremiereBakeJobs(source, plan, {
      onProgress: (job, index, total) => progress.push([job.itemId, index, total]),
    });
    assert.deepEqual([...rendered.media.entries()], [['complicated', { visualSrc: '/media/uploads/complicated-visual.mov' }]]);
    assert.deepEqual(rendered.issues, []);
    assert.equal(Object.hasOwn(rendered.media.get('complicated')!, 'audioSrc'), false,
      'a visual-only bake never claims or replaces source audio');
    assert.deepEqual(progress, [['complicated', 1, 1]], 'each isolated job advances progress once');
    assert.equal(calls.length, 1);
    assert.equal(String(calls[0]!.input), '/render-clip');
    assert.equal(calls[0]!.init?.method, 'POST');
    const requestHeaders = calls[0]!.init?.headers as Record<string, string> | undefined;
    assert.equal(requestHeaders?.['Content-Type'], 'application/json');
    const payload = JSON.parse(String(calls[0]!.init?.body)) as {
      codec: string; transparent: boolean; mode: string; filename: string; state: TimelineState;
    };
    assert.deepEqual({ codec: payload.codec, transparent: payload.transparent, mode: payload.mode },
      { codec: 'prores', transparent: true, mode: 'bake' }, 'render request is an alpha-capable ProRes bake');
    assert.equal(payload.filename, plan.bakeJobs[0]!.filename);
    assert.equal(payload.state.items.length, 1, 'bake state contains only the requested item');
    assert.equal(payload.state.items[0]!.id, 'complicated');
    assert.equal(payload.state.items[0]!.startFrame, 0, 'the isolated item starts at frame zero');
    assert.equal(payload.state.items[0]!.volume, 0, 'visual render mutes embedded source audio');
    assert.deepEqual(payload.state.transitions, [], 'timeline transitions are removed from the isolated clip render');
    assert.deepEqual(payload.state.markers, [], 'timeline markers are removed from the isolated clip render');
    assert.equal(payload.state.captions, null, 'global captions are not composited into the clip');
    assert.equal(payload.state.tracks?.V1 && 'captions' in payload.state.tracks.V1, false,
      'track-owned captions are removed from the isolated clip');
    assert.deepEqual(payload.state.watermark, { enabled: false, text: '', position: 'br', opacity: 0.5 },
      'the project watermark is disabled in the isolated layer render');
    const direct = premiereBakeState(source, selected, 'visual');
    assert.deepEqual(direct.items.map((candidate) => candidate.id), ['complicated']);
  } finally {
    globalThis.fetch = oldFetch;
  }
}

// ── Audio bake: only a returned audioSrc marks the original sound as replaced ──
{
  const voice = item('denoised-voice', 'A1', 'audio', { denoisedSrc: '/media/uploads/denoised-voice-clean.wav' });
  const source = state([voice, item('visual-neighbor', 'V1', 'video')]);
  const plan = planPremiereExport(source);
  assert.deepEqual(plan.bakeJobs.map(({ itemId, kind }) => [itemId, kind]), [['denoised-voice', 'audio']]);
  const oldFetch = globalThis.fetch;
  let posted: TimelineState | undefined;
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { state: TimelineState };
    posted = body.state;
    return Response.json({ path: '/media/uploads/denoised-render.wav' });
  }) as typeof fetch;
  try {
    const rendered = await renderPremiereBakeJobs(source, plan);
    assert.deepEqual([...rendered.media.entries()], [['denoised-voice', { audioSrc: '/media/uploads/denoised-render.wav' }]]);
    assert.deepEqual(posted?.items.map((candidate) => [candidate.id, candidate.kind, candidate.startFrame]),
      [['denoised-voice', 'audio', 0]], 'audio bake carries only the source clip as audio at frame zero');
  } finally {
    globalThis.fetch = oldFetch;
  }
}

// ── A failed half of a two-stream bake suppresses all media for that item ──
{
  const bothStreams = item('both-streams', 'V1', 'video', {
    effects: [{ id: 'fx', assetId: 'builtin:fx-glow' }],
    denoisedSrc: '/media/uploads/clean.wav',
  });
  const source = state([bothStreams]);
  const plan = planPremiereExport(source);
  assert.deepEqual(plan.bakeJobs.map(({ kind }) => kind), ['visual', 'audio']);
  let callIndex = 0;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    callIndex += 1;
    return callIndex === 1
      ? Response.json({ path: '/media/uploads/visual-only.mov' })
      : Response.json({ error: 'audio render failed' }, { status: 500 });
  }) as typeof fetch;
  try {
    const rendered = await renderPremiereBakeJobs(source, plan);
    assert.equal(callIndex, 2, 'both planned stream renders were attempted');
    assert.equal(rendered.media.has('both-streams'), false,
      'a successful visual result is not exposed as a partial success when audio baking fails');
    assert.deepEqual(rendered.issues.map(({ severity, code, itemIds }) => [severity, code, itemIds]), [
      ['error', 'premiere-clip-bake-failed', ['both-streams']],
    ]);
  } finally {
    globalThis.fetch = oldFetch;
  }
}

// ── Invalid destinations and cancellation never become successful bake media ──
{
  const selected = item('must-not-fallback', 'V1', 'video', { effects: [{ id: 'fx', assetId: 'builtin:fx-glow' }] });
  const source = state([selected]);
  const plan = planPremiereExport(source);
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ path: 'C:\\outside\\unmanaged.mov' })) as typeof fetch;
  try {
    const invalid = await renderPremiereBakeJobs(source, plan);
    assert.equal(invalid.media.has(selected.id), false, 'an unmanaged path cannot be represented as a successful bake');
    assert.equal(invalid.issues[0]?.code, 'premiere-clip-bake-failed');
  } finally {
    globalThis.fetch = oldFetch;
  }

  const controller = new AbortController();
  let seenSignal: AbortSignal | null | undefined;
  globalThis.fetch = (async (_input, init) => {
    seenSignal = init?.signal;
    controller.abort();
    return Response.json({ path: '/media/uploads/too-late.mov' });
  }) as typeof fetch;
  try {
    await assert.rejects(renderPremiereBakeJobs(source, plan, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(seenSignal, controller.signal, 'the caller abort signal reaches the render request');
  } finally {
    globalThis.fetch = oldFetch;
  }
}

// ── Plan-level errors prevent bake requests altogether ──
{
  const selected = item('with-caption-overlay', 'V1', 'video', { effects: [{ id: 'fx', assetId: 'builtin:fx-glow' }] });
  const source = state([selected], {
    captions: { enabled: true, template: 'plain', pacing: 'phrase', words: [{ text: 'hello', start: 0, end: 500 }] },
  });
  const plan: PremiereExportPlan = planPremiereExport(source);
  assert.ok(plan.issues.some((issue) => issue.severity === 'error' && issue.code === 'premiere-captions-require-composite'));
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return Response.json({ path: '/media/uploads/should-not-exist.mov' });
  }) as typeof fetch;
  try {
    const rendered = await renderPremiereBakeJobs(source, plan);
    assert.equal(calls, 0, 'timeline-level errors stop before a placeholder render request');
    assert.equal(rendered.media.size, 0, 'plan errors produce no success media');
  } finally {
    globalThis.fetch = oldFetch;
  }
}

console.log('premiereBake.verify: ok (isolated ProRes layers/visual-only map/audio map/failure suppression/cancellation)');
