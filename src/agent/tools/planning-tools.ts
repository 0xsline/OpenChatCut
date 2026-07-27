import type { AgentToolSchema } from '../tool-schema';

// Deterministic planning + verification tools so the agent can't under-write long-form videos.
// LLMs tend to produce ~500 words when asked for 2500; these tools enforce a real word budget.
//   plan_scenes          → target_words/duration → structured scene breakdown (math, not LLM guess)
//   verify_word_budget   → count actual narration words vs target → shortfall + under-budget scenes.
// The agent MUST call verify before declaring the script done; shortfall > 0 means expand, not stop.

// Narration speaking rate (words/second): converts target duration ↔ word budget so the
// planned word count matches the REAL voiceover audio length. Calibrated to joni (KikiVoice
// clone, Indonesian): empirically ~2.5 WPS (150 WPM) at speed:'1'. OpenCut-AI measured the
// same value — their session log shows "joni 2.50" fixed a prior 1.92 bug that under-delivered
// duration by ~23%. A too-low value here makes the agent write too few words → audio shorter
// than the target. Override via VITE_NARRATION_WPS for a different voice/language.
const NARRATION_WPS_ENV = Number(import.meta.env?.VITE_NARRATION_WPS as string | undefined);
export const NARRATION_WPS = Number.isFinite(NARRATION_WPS_ENV) && NARRATION_WPS_ENV > 0 ? NARRATION_WPS_ENV : 2.5;

export const PLANNING_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'plan_scenes',
    description: 'Plan a deterministic scene breakdown with a per-scene word budget for a target video length. Call this BEFORE writing narration so every scene has a concrete word target and the total hits the requested length. Returns phase -> scene_count -> word_budget, plus words_per_scene. No guessing — math only.',
    input_schema: {
      type: 'object',
      properties: {
        target_words: { type: 'number', description: 'Requested narration word count (the floor). e.g. 2500.' },
        duration_seconds: { type: 'number', description: `Target video length in seconds. If given, target_words = max(target_words, duration_seconds × ${NARRATION_WPS} wps narration density — calibrated to the joni voiceover rate).` },
        scene_count: { type: 'number', description: 'Optional scene count override. Default: target_words / 60 (~60 words/scene, ~30s each).' },
      },
      required: ['target_words'],
    },
  },
  {
    name: 'verify_word_budget',
    description: 'Count the actual narration words across scenes and compare to the target. You MUST call this before declaring the script/video finished. If shortfall > 0 (status UNDER_BUDGET), expand the listed under-budget scenes or add scenes until meets_floor is true — do NOT stop under budget.',
    input_schema: {
      type: 'object',
      properties: {
        scenes: {
          type: 'array',
          description: 'Scenes with their narration text and (optional) per-scene word budget from plan_scenes.',
          items: {
            type: 'object',
            properties: {
              narration: { type: 'string', description: 'The spoken narration text for this scene.' },
              budget: { type: 'number', description: 'Optional word budget for this scene from plan_scenes.' },
            },
            required: ['narration'],
          },
        },
        target_words: { type: 'number', description: 'The target/floor word count (from plan_scenes or the user request).' },
      },
      required: ['scenes', 'target_words'],
    },
  },
  {
    name: 'verify_timeline_sync',
    description: [
      'Verify footage timeline is sync-correct: (1) every video/image clip is <= max_clip_seconds (default 6s), (2) NO gaps in video coverage over the VO audio (footage must be contiguous, no silent/empty spans), (3) total footage coverage ~= audio duration.',
      'You MUST call this before declaring the video done. If status is ISSUES, FIX the listed over-length clips (split them) and gaps (fill with footage) — do NOT declare done.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        video_clips: {
          type: 'array',
          description: 'All video/image footage clips on the timeline (track V1), each with startFrame + durationInFrames.',
          items: {
            type: 'object',
            properties: {
              startFrame: { type: 'number' },
              durationInFrames: { type: 'number' },
              name: { type: 'string' },
            },
            required: ['startFrame', 'durationInFrames'],
          },
        },
        audio_duration_frames: { type: 'number', description: 'Total VO audio duration in frames (last audio clip endFrame, or sum). Footage must cover this fully.' },
        fps: { type: 'number', description: 'Timeline fps (default 30).' },
        max_clip_seconds: { type: 'number', default: 6, description: 'Max seconds per footage clip (default 6).' },
      },
      required: ['video_clips', 'audio_duration_frames'],
    },
  },
];

export const PLANNING_TOOL_NAMES = new Set(PLANNING_TOOL_SCHEMAS.map((t) => t.name));

// Geopolitical funnel-arc phase weights (HOOK 10% / CONTEXT 30% / ESCALATION 40% / IMPACT 20%).
const PHASES = [
  { phase: 'HOOK', weight: 0.10 },
  { phase: 'CONTEXT', weight: 0.30 },
  { phase: 'ESCALATION', weight: 0.40 },
  { phase: 'IMPACT (incl. Indonesia connection)', weight: 0.20 },
] as const;

export async function execPlanningTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === 'plan_scenes') return planScenes(args);
  if (name === 'verify_word_budget') return verifyWordBudget(args);
  if (name === 'verify_timeline_sync') return verifyTimelineSync(args);
  return { error: `unknown planning tool ${name}` };
}

/** Verify footage timeline: every clip <= max_clip_seconds (default 6s), NO gaps in coverage over
 *  the VO audio, and total coverage ~= audio duration. The agent MUST call this before declaring
 *  the video done; ISSUES means FIX over-length clips (split) + gaps (fill), not stop. */
function verifyTimelineSync(args: Record<string, unknown>): unknown {
  const rawClips = Array.isArray(args.video_clips) ? args.video_clips : [];
  const audioDur = Number(args.audio_duration_frames);
  const fps = Number(args.fps) > 0 ? Number(args.fps) : 30;
  const maxSec = Number(args.max_clip_seconds) > 0 ? Number(args.max_clip_seconds) : 6;
  const maxFrames = Math.round(maxSec * fps);
  if (!Number.isFinite(audioDur) || audioDur <= 0) return { error: 'audio_duration_frames must be a positive number' };
  const clips = rawClips
    .map((c, i) => {
      const o = (c ?? {}) as Record<string, unknown>;
      return { index: i + 1, name: String(o.name ?? `clip ${i + 1}`), startFrame: Number(o.startFrame) || 0, durationInFrames: Number(o.durationInFrames) || 0 };
    })
    .filter((c) => c.durationInFrames > 0)
    .sort((a, b) => a.startFrame - b.startFrame);
  if (!clips.length) return { status: 'ISSUES', error: 'no video clips provided', action: 'Place footage on V1 covering the full VO audio before verifying.' };
  // (1) clips over max
  const over = clips
    .filter((c) => c.durationInFrames > maxFrames)
    .map((c) => ({ index: c.index, name: c.name, durationInFrames: c.durationInFrames, seconds: Math.round((c.durationInFrames / fps) * 10) / 10 }));
  // (2) gaps + overlaps: walk sorted clips tracking the union extent (prevEnd).
  const gaps: Array<{ from: number; to: number; gap_frames: number; gap_seconds: number }> = [];
  const overlaps: Array<{ index: number; name: string; overlap_frames: number; overlap_seconds: number }> = [];
  let prevEnd = 0;
  let unionCovered = 0; // unique frames covered (overlaps not double-counted)
  for (const c of clips) {
    const cEnd = c.startFrame + c.durationInFrames;
    if (c.startFrame > prevEnd) {
      const gf = c.startFrame - prevEnd;
      gaps.push({ from: prevEnd, to: c.startFrame, gap_frames: gf, gap_seconds: Math.round((gf / fps) * 10) / 10 });
      unionCovered += c.durationInFrames; // disjoint segment — count it whole
    } else if (c.startFrame < prevEnd) {
      // overlap: this clip starts before the previous one ends (wasted frames)
      const of = prevEnd - c.startFrame;
      overlaps.push({ index: c.index, name: c.name, overlap_frames: of, overlap_seconds: Math.round((of / fps) * 10) / 10 });
      unionCovered += Math.max(0, cEnd - prevEnd); // only the part extending past prevEnd
    } else {
      unionCovered += c.durationInFrames; // contiguous
    }
    prevEnd = Math.max(prevEnd, cEnd);
  }
  if (prevEnd < audioDur) {
    const gf = audioDur - prevEnd;
    gaps.push({ from: prevEnd, to: audioDur, gap_frames: gf, gap_seconds: Math.round((gf / fps) * 10) / 10 });
  }
  // (3) coverage — union-based so overlapping regions aren't double-counted
  const coveragePct = Math.round((unionCovered / audioDur) * 100);
  const ok = over.length === 0 && gaps.length === 0 && overlaps.length === 0 && coveragePct >= 99;
  return {
    status: ok ? 'ok' : 'ISSUES',
    max_clip_seconds: maxSec,
    max_clip_frames: maxFrames,
    clip_count: clips.length,
    over_length_clips: over,
    gaps,
    overlaps,
    coverage_pct: coveragePct,
    total_video_frames: unionCovered,
    audio_duration_frames: audioDur,
    action: ok
      ? 'Timeline sync OK — all clips <=6s, no gaps, no overlaps, full coverage.'
      : `FIX: ${over.length} over-length clip(s) (split into <=${maxSec}s), ${gaps.length} gap(s) totaling ${gaps.reduce((s, g) => s + g.gap_frames, 0)} frames (fill with footage), ${overlaps.length} overlap(s) totaling ${overlaps.reduce((s, o) => s + o.overlap_frames, 0)} frames (re-align so clips abut, not overlap), coverage ${coveragePct}% (need ~100%). Do NOT declare done until status is ok.`,
  };
}

function planScenes(args: Record<string, unknown>): unknown {
  const requested = Number(args.target_words);
  if (!Number.isFinite(requested) || requested <= 0) return { error: 'target_words must be a positive number' };
  const durationSeconds = typeof args.duration_seconds === 'number' ? args.duration_seconds : undefined;
  const computedFromDuration = durationSeconds ? Math.ceil(durationSeconds * NARRATION_WPS) : 0;
  const targetWords = Math.max(requested, computedFromDuration);
  const sceneCount = typeof args.scene_count === 'number' && args.scene_count > 0
    ? Math.round(args.scene_count)
    : Math.max(4, Math.round(targetWords / 60));
  const perScene = Math.round(targetWords / sceneCount);
  const phases = PHASES.map((p) => {
    const scenes = Math.max(1, Math.round(sceneCount * p.weight));
    return { phase: p.phase, scene_count: scenes, word_budget: scenes * perScene };
  });
  const floor = Math.round(targetWords * 0.9);
  const impliedDurationSec = Math.ceil(targetWords / NARRATION_WPS);
  const impliedMin = Math.round(impliedDurationSec / 60 * 10) / 10;
  const requestedMin = durationSeconds ? Math.round(durationSeconds / 60 * 10) / 10 : null;
  // Conflict: user asked for X words AND Y duration, but X words @ NARRATION_WPS needs more seconds,
  // which is >20% longer than Y. Flag it so the agent/user picks one instead of pretending.
  const conflict = computedFromDuration > 0 && requested > computedFromDuration * 1.2;
  return {
    target_words: targetWords,
    duration_seconds: durationSeconds,
    implied_duration_seconds: impliedDurationSec,
    implied_duration_minutes: impliedMin,
    scene_count: sceneCount,
    words_per_scene: perScene,
    narration_density_wps: NARRATION_WPS,
    phases,
    floor_90pct: floor,
    ...(conflict ? {
      CONFLICT: `Requested ${requested} words but duration ${durationSeconds}s only fits ${computedFromDuration} words @ ${NARRATION_WPS} wps. ${requested} words actually need ~${impliedDurationSec}s (~${impliedMin} min). PICK ONE before writing: (a) keep ~${computedFromDuration} words for a true ${requestedMin}-min video (~${Math.max(4, Math.round(computedFromDuration / 60))} scenes), OR (b) extend duration to ~${impliedMin} min for ${requested} words (${sceneCount} scenes). Do NOT pretend ${requested} words fits ${durationSeconds}s — at ${NARRATION_WPS} wps it does not.`,
    } : {}),
    note: `Write EACH scene to ~${perScene} words. Total target = ${targetWords} = ~${impliedMin} min @ ${NARRATION_WPS} wps. Do NOT declare done below 90% (${floor} words). Verify with verify_word_budget before finishing.`,
  };
}

function verifyWordBudget(args: Record<string, unknown>): unknown {
  const rawScenes = Array.isArray(args.scenes) ? args.scenes : [];
  const target = Number(args.target_words);
  if (!Number.isFinite(target) || target <= 0) return { error: 'target_words must be a positive number' };
  const scenes = rawScenes.map((s, i) => {
    const obj = (s ?? {}) as Record<string, unknown>;
    const narration = String(obj.narration ?? '');
    const budget = Number(obj.budget);
    const words = narration.split(/\s+/).filter(Boolean).length;
    return {
      index: i + 1,
      words,
      budget: Number.isFinite(budget) ? budget : undefined,
      under_budget: Number.isFinite(budget) ? words < budget * 0.9 : false,
    };
  });
  const total = scenes.reduce((sum, s) => sum + s.words, 0);
  const floor = Math.round(target * 0.9);
  const shortfall = Math.max(0, target - total);
  const underBudget = scenes.filter((s) => s.under_budget);
  const meets = total >= floor;
  return {
    total_words: total,
    target_words: target,
    floor_90pct: floor,
    shortfall,
    meets_floor: meets,
    status: meets ? 'ok' : 'UNDER_BUDGET',
    under_budget_scenes: underBudget.map((s) => ({ index: s.index, words: s.words, budget: s.budget })),
    scene_count: scenes.length,
    action: meets
      ? 'Word budget met — narration length OK.'
      : `UNDER BUDGET by ${shortfall} words across ${scenes.length} scenes. Expand the ${underBudget.length} under-budget scene(s) above, or add ~${Math.max(1, Math.ceil(shortfall / 60))} new scene(s), until total_words >= ${floor}. Do NOT declare the video finished.`,
  };
}
