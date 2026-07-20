// The propose→apply contract. Structural agent edits are
// captured as a PROPOSAL (options → operations), reviewed by the user, then
// committed atomically on approve — the agent never mutates the timeline directly.
// Shape: (Proposal{title,summary,totalImpact,options[]} →
// Option{id,label,recommended,summary,totalImpact,operations[]} →
// Operation{tool,args,action,target,impact,risk,rationale}); we additionally
// carry the store actions per operation so approve can replay them atomically.
import type { AnyAction } from '../editor/store';
import type { ProjectDoc, TimelineState } from '../editor/types';
import { migrateProjectDoc } from '../persist/projectStore';

export interface Operation {
  tool: string;
  args: Record<string, unknown>;
  /** store actions this tool produced — replayed on approve (one atomic commit) */
  actions: AnyAction[];
  action: string; // human verb
  target: string; // what it affects
  impact: string; // per-op impact
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
  /** project snapshot at propose time — apply is stale if anything changed */
  baseDoc: ProjectDoc;
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
  manage_timelines: '管理序列',
  edit_track: '管理轨道',
  manage_media_pool: '整理素材池',
  apply_script: '改稿应用',
  manage_effects: '特效',
  edit_item: '编辑片段',
  browse_library: '浏览资源库',
};

function targetOf(args: Record<string, unknown>, actions: AnyAction[]): string {
  const name = args.name ?? args.query ?? args.template ?? args.ratio;
  if (typeof name === 'string') return name;
  const id = args.id ?? args.itemId ?? args.timelineId ?? args.targetItemId ?? args.assetId;
  if (typeof id === 'string') return id;
  // fall back to the first added/edited item's or timeline's name
  for (const a of actions) {
    if (a.type === 'add' && a.item?.name) return a.item.name;
    if (a.type === 'tl.create') return a.timeline.name;
    if (a.type === 'tl.duplicate' || a.type === 'tl.rename') return a.name;
  }
  return '时间线';
}

function impactOf(actions: AnyAction[]): string {
  let add = 0, del = 0, mod = 0, addSeq = 0, delSeq = 0;
  for (const a of actions) {
    if (a.type === 'add' || a.type === 'duplicate' || a.type === 'split') add++;
    else if (a.type === 'remove') del++;
    else if (a.type === 'tl.create' || a.type === 'tl.duplicate') addSeq++;
    else if (a.type === 'tl.delete') delSeq++;
    else if (a.type === 'tl.switch') continue; // navigation, not an edit
    else mod++;
  }
  const parts: string[] = [];
  if (addSeq) parts.push(`+${addSeq} 序列`);
  if (delSeq) parts.push(`−${delSeq} 序列`);
  if (add) parts.push(`+${add} 片段`);
  if (del) parts.push(`−${del} 片段`);
  if (mod) parts.push(`${mod} 处改动`);
  return parts.join(' · ') || '无变化';
}

export function buildOperation(tool: string, args: Record<string, unknown>, actions: AnyAction[]): Operation {
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

// wrap collected operations into a single-option proposal (operations lacking
// explicit options are auto-wrapped into one recommended option).
export function buildProposal(operations: Operation[], assistantText: string, baseDoc: ProjectDoc, resultState: TimelineState): Proposal {
  const totalImpact = impactOf(operations.flatMap((o) => o.actions));
  const summary = assistantText.trim() || `${operations.length} 项编辑`;
  return {
    title: 'Agent 编辑提案',
    summary,
    totalImpact,
    options: [{ id: 'opt-1', label: '应用全部', recommended: true, summary, totalImpact, operations }],
    baseDoc,
    resultState,
  };
}

/**
 * Stale when the live project no longer matches the snapshot used to build the
 * proposal. In-session, ProjectDoc updates are immutable → reference inequality
 * is enough and cheap. After IDB rehydrate, baseDoc is a deep clone and may have
 * passed migrateProjectDoc (track normalization, etc.), so fall back to
 * structural equality of *normalized* docs.
 */
export function isProposalStale(proposal: Proposal, currentDoc: ProjectDoc): boolean {
  if (proposal.baseDoc === currentDoc) return false;
  try {
    const left = migrateProjectDoc(proposal.baseDoc) ?? proposal.baseDoc;
    const right = migrateProjectDoc(currentDoc) ?? currentDoc;
    return JSON.stringify(left) !== JSON.stringify(right);
  } catch {
    return true;
  }
}

/** Generated files are durable side effects: save assets now, propose only timeline edits. */
export function partitionProposalActions(actions: AnyAction[]): { persistent: AnyAction[]; proposed: AnyAction[] } {
  return {
    persistent: actions.filter((action) => action.type === 'addAsset'),
    proposed: actions.filter((action) => action.type !== 'addAsset'),
  };
}
