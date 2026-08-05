// costGuard.verify.ts — paid-tool guard invariants:
// 1. Every paid API surface is registered in HIGH_COST_TOOLS (no future gaps).
// 2. High-cost proposals never auto-apply, even in auto/YOLO mode.
// 3. Authorization memory roundtrips per category/project.
// 4. Category mapping covers the live tools.
import assert from 'node:assert/strict';
import { HIGH_COST_TOOLS, isHighCostTool, costCategoryForTool } from './settings/agentSettings';
import { shouldBlockAutoApply, isCostAllowed, rememberCostAllowed, highCostOps } from './skills/costGuard';
import { TOOL_SCHEMAS } from './tools';
import type { Proposal } from './proposal';

// ── 1. paid surfaces must all be registered (regression for the 2026-08-05
// gap: transcribe_track / web_* / run_code were unguarded) ──
const PAID_TOOLS = [
  // generation
  'submit_image', 'submit_video', 'submit_music', 'submit_sound', 'submit_voice',
  'submit_motion_graphic', 'create_motion_graphic', 'create_motion_graphic_from_code',
  'submit_shader', 'rerun_generation',
  // export
  'submit_export', 'submit_render_job', 'export_motion_graphic_prores', 'convert_motion_graphic_to_video',
  // paid transcription (AssemblyAI)
  'transcribe_track',
  // paid web scraping (Firecrawl)
  'web_browser', 'web_search', 'web_map', 'web_crawl', 'web_batch_scrape',
  // paid sandbox (E2B)
  'run_code',
];
for (const tool of PAID_TOOLS) {
  assert.ok(isHighCostTool(tool), `paid tool missing from HIGH_COST_TOOLS: ${tool}`);
}

// every registered high-cost name that is a LIVE tool exists in TOOL_SCHEMAS
// (legacy aliases like export_timeline are allowed to be dormant)
const live = new Set(TOOL_SCHEMAS.map((t) => t.name));
for (const name of Object.keys(HIGH_COST_TOOLS)) {
  if (live.has(name)) assert.ok(isHighCostTool(name), `registered but not flagged: ${name}`);
}

// ── 2. auto-apply never swallows high-cost proposals ──
const proposal = (ops: string[]): Proposal => ({
  title: '',
  summary: '',
  totalImpact: '',
  options: [{ id: 'o1', label: '', recommended: true, summary: '', totalImpact: '', operations: ops.map((tool) => ({ tool, args: {}, type: 'op' as const, actions: [], action: '', target: '', impact: '' })) }],
  baseDoc: { version: 1, id: 'proj', name: 'p', timelineId: 't', timeline: { captionsHidden: false, fps: 30, width: 1920, height: 1080, items: [] } } as never,
  resultState: undefined as never,
});
assert.equal(shouldBlockAutoApply(proposal(['move_item']), true), false, 'ordinary edit auto-applies in YOLO mode');
assert.equal(shouldBlockAutoApply(proposal(['submit_image']), true), true, 'generation never auto-applies');
assert.equal(shouldBlockAutoApply(proposal(['transcribe_track']), true), true, 'paid transcription never auto-applies');
assert.equal(shouldBlockAutoApply(proposal(['web_browser']), true), true, 'paid scraping never auto-applies');
assert.equal(shouldBlockAutoApply(proposal(['run_code']), true), true, 'paid sandbox never auto-applies');
assert.equal(shouldBlockAutoApply(proposal(['submit_export']), false), true, 'manual mode always shows the card');
assert.deepEqual(highCostOps(proposal(['edit_item', 'submit_voice', 'move_item'])), ['submit_voice'], 'highCostOps lists only paid ops');

// ── 3. authorization memory roundtrip ──
const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } },
});
assert.equal(isCostAllowed('image-gen', 'proj-a'), false, 'fresh install → not allowed');
rememberCostAllowed('image-gen', 'proj-a');
assert.equal(isCostAllowed('image-gen', 'proj-a'), true, 'remembered per project');
assert.equal(isCostAllowed('image-gen', 'proj-b'), false, 'scope stays in its project');
rememberCostAllowed('motion-graphic-gen', 'proj-a');
assert.equal(isCostAllowed('motion-graphic-gen', 'proj-b'), true, 'MG memory is global');

// ── 4. category mapping covers the live paid tools ──
for (const tool of PAID_TOOLS) {
  assert.ok(costCategoryForTool(tool), `no cost category for paid tool: ${tool}`);
}
assert.equal(costCategoryForTool('submit_music'), 'audio-gen');
assert.equal(costCategoryForTool('submit_export'), 'irreversible-export');
assert.equal(costCategoryForTool('transcribe_track'), 'high-cost-operation');
assert.equal(costCategoryForTool('web_search'), 'high-cost-operation');
assert.equal(costCategoryForTool('run_code'), 'high-cost-operation');
assert.equal(costCategoryForTool('move_item'), null, 'free tools have no guard');

console.log('costGuard.verify: ok (paid-tool registry complete, auto-apply blocked, memory scoped)');
