import type { AgentToolSchema } from '../tool-schema';

// Deterministic planning + verification tools so the agent can't under-write long-form videos.
// LLMs tend to produce ~500 words when asked for 2500; these tools enforce a real word budget.
//   plan_scenes          → target_words/duration → structured scene breakdown (math, not LLM guess)
//   verify_word_budget   → count actual narration words vs target → shortfall + under-budget scenes.
// The agent MUST call verify before declaring the script done; shortfall > 0 means expand, not stop.

export const PLANNING_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'plan_scenes',
    description: 'Plan a deterministic scene breakdown with a per-scene word budget for a target video length. Call this BEFORE writing narration so every scene has a concrete word target and the total hits the requested length. Returns phase -> scene_count -> word_budget, plus words_per_scene. No guessing — math only.',
    input_schema: {
      type: 'object',
      properties: {
        target_words: { type: 'number', description: 'Requested narration word count (the floor). e.g. 2500.' },
        duration_seconds: { type: 'number', description: 'Target video length in seconds. If given, target_words = max(target_words, duration_seconds × 2.0 wps narration density).' },
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
  return { error: `unknown planning tool ${name}` };
}

function planScenes(args: Record<string, unknown>): unknown {
  const requested = Number(args.target_words);
  if (!Number.isFinite(requested) || requested <= 0) return { error: 'target_words must be a positive number' };
  const durationSeconds = typeof args.duration_seconds === 'number' ? args.duration_seconds : undefined;
  const computedFromDuration = durationSeconds ? Math.ceil(durationSeconds * 2.0) : 0;
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
  return {
    target_words: targetWords,
    duration_seconds: durationSeconds,
    scene_count: sceneCount,
    words_per_scene: perScene,
    narration_density_wps: 2.0,
    phases,
    floor_90pct: floor,
    note: `Write EACH scene to ~${perScene} words. Total target = ${targetWords}. Do NOT declare done below 90% (${floor} words). Verify with verify_word_budget before finishing.`,
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
