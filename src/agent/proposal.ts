// The propose→apply contract (source: edit-proposal). Structural agent edits are
// captured as a PROPOSAL (options → operations), reviewed by the user, then
// committed atomically on approve — the agent never mutates the timeline directly.
// Faithful to ChatCut's model (Proposal{title,summary,totalImpact,options[]} →
// Option{id,label,recommended,summary,totalImpact,operations[]} →
// Operation{tool,args,action,target,impact,risk,rationale}); we additionally
// carry the store actions per operation so approve can replay them atomically.
import type { Action } from '../editor/store';
import type { TimelineState } from '../editor/types';

export interface Operation {
  tool: string;
  args: Record<string, unknown>;
  /** store actions this tool produced — replayed on approve (one atomic commit) */
  actions: Action[];
  action: string; // human verb (source field: action)
  target: string; // what it affects (source field: target)
  impact: string; // per-op impact (source field: impact)
  rationale?: string;
}

export interface ProposalOption {
  id: string;
  label: string;
  recommended: boolean;
  summary: string;
  totalImpact: string;
  operations: Operation[];
}

export interface Proposal {
  title: string;
  summary: string;
  totalImpact: string;
  options: ProposalOption[];
  /** snapshot at propose time — apply is stale if the live timeline moved past it */
  baseState: TimelineState;
  /** draft result — used for the in-player preview */
  resultState: TimelineState;
}

// map an agent tool call + the store actions it produced into a display Operation.
const VERB: Record<string, string> = {
  add_motion_graphic: '添加动画',
  create_motion_graphic: '生成动画',
  add_audio: '添加音频',
  update_item_props: '改属性',
  move_item: '移动片段',
  set_item_timing: '改时长/位置',
  duplicate_item: '复制片段',
  remove_item: '删除片段',
  split_item: '切分片段',
  clear_timeline: '清空时间线',
  set_aspect_ratio: '改画面比例',
  set_item_transcript: '挂转写',
  delete_text: '删文字=删视频',
  clean_script: '清理口播',
  edit_captions: '编辑字幕',
};

function targetOf(args: Record<string, unknown>, actions: Action[]): string {
  const name = args.name ?? args.query ?? args.template ?? args.ratio;
  if (typeof name === 'string') return name;
  const id = args.id ?? args.itemId;
  if (typeof id === 'string') return id;
  // fall back to the first added/edited item's name
  for (const a of actions) {
    if (a.type === 'add' && a.item?.name) return a.item.name;
  }
  return '时间线';
}

function impactOf(actions: Action[]): string {
  let add = 0;
  let del = 0;
  let mod = 0;
  for (const a of actions) {
    if (a.type === 'add' || a.type === 'duplicate' || a.type === 'split') add++;
    else if (a.type === 'remove') del++;
    else mod++;
  }
  const parts: string[] = [];
  if (add) parts.push(`+${add} 片段`);
  if (del) parts.push(`−${del} 片段`);
  if (mod) parts.push(`${mod} 处改动`);
  return parts.join(' · ') || '无变化';
}

export function buildOperation(tool: string, args: Record<string, unknown>, actions: Action[]): Operation {
  return {
    tool,
    args,
    actions,
    action: VERB[tool] ?? tool,
    target: targetOf(args, actions),
    impact: impactOf(actions),
    rationale: typeof args.rationale === 'string' ? args.rationale : undefined,
  };
}

// wrap collected operations into a single-option proposal (source auto-wraps
// operations lacking explicit options into one recommended option).
export function buildProposal(operations: Operation[], assistantText: string, baseState: TimelineState, resultState: TimelineState): Proposal {
  const totalImpact = impactOf(operations.flatMap((o) => o.actions));
  const summary = assistantText.trim() || `${operations.length} 项编辑`;
  return {
    title: 'Agent 编辑提案',
    summary,
    totalImpact,
    options: [{ id: 'opt-1', label: '应用全部', recommended: true, summary, totalImpact, operations }],
    baseState,
    resultState,
  };
}
