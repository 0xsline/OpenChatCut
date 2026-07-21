// apply_script diff engine: compare the edited timeline.md with the live
// canonical state and map it back to deterministic editor commands. Row
// identity uses [sN]/[cN] ids plus each ### source mapping; kept text is
// content-matched against the corresponding segment (tolerant
// to case/punctuation/whitespace, NOT to changed words); frames are never
// authored in the file — the track is repacked from body order (apply
// re-derives all frames). Any error aborts before any command is dispatched
// (plan first, dispatch after = atomic).
import type { TimelineItem, TimelineState, TrackId } from '../editor/types';
import type { EditorCommands } from '../editor/store';
import { itemById, serializeTimeline, type Row, type SegRow, type SilenceRow } from './serialize';
import { parseScript, type ParsedRun, type ParsedSegRow, type ParsedSilenceRow } from './parse';

type Cmds = Pick<EditorCommands, 'deleteWords' | 'toggleWord' | 'removeItem' | 'moveItem' | 'setGapCap'>;

export interface ApplyScriptOptions { trackId?: TrackId }

export interface ApplyResult {
  ok: true;
  /** rows/clips that disappeared vs the canonical state (`Removed:` audit) */
  removed: string[];
  changes: string[];
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// consume words from `words[wi..]` whose normalized concat equals the run text
function consumeRun(words: { text: string }[], wi: number, run: ParsedRun, line: number): number {
  const target = norm(run.text);
  if (!target) return wi; // punctuation-only run
  let acc = '';
  let i = wi;
  while (i < words.length && acc.length < target.length) {
    acc += norm(words[i].text);
    i++;
  }
  if (acc !== target) {
    throw new Error(`timeline.md 第 ${line} 行: 文本与源口播不匹配（"${run.text.slice(0, 20)}"）——只能删词/恢复词，不能改写口播`);
  }
  return i;
}

// plan of one transcript item's word edits
interface WordPlan { item: TimelineItem; toDelete: number[]; toRestore: number[]; removeWhole: boolean }

function planSegRows(item: TimelineItem, canonRows: SegRow[], parsedRows: ParsedSegRow[]): WordPlan {
  const words = item.transcript!;
  const currentDeleted = new Set(item.deletedWordIdx ?? []);
  const bySn = new Map<number, ParsedSegRow>();
  for (const r of parsedRows) {
    if (r.occurrence !== undefined) throw new Error(`timeline.md 第 ${r.line} 行: [s${r.sn}@${r.occurrence}] 重复占位暂不支持`);
    if (bySn.has(r.sn)) throw new Error(`timeline.md 第 ${r.line} 行: [s${r.sn}] 出现两次（重放暂不支持）`);
    bySn.set(r.sn, r);
  }
  const knownSns = new Set(canonRows.map((r) => r.sn));
  for (const r of parsedRows) {
    if (!knownSns.has(r.sn)) throw new Error(`timeline.md 第 ${r.line} 行: [s${r.sn}] 不在当前时间线上（新增/重放暂不支持）`);
  }
  // v1: segment order within the item must be unchanged
  const parsedOrder = parsedRows.map((r) => r.sn);
  const canonOrder = canonRows.map((r) => r.sn).filter((sn) => bySn.has(sn));
  if (parsedOrder.join(',') !== canonOrder.join(',')) {
    throw new Error(`「${item.name}」: 段落重排暂不支持（可整体移动素材行，不能在素材内部调换 [sN] 顺序）`);
  }

  const desiredDeleted = new Set<number>();
  for (const canon of canonRows) {
    const parsed = bySn.get(canon.sn);
    const segWords = canon.wordGis.map((gi) => words[gi]);
    if (!parsed || parsed.struck) {
      for (const gi of canon.wordGis) desiredDeleted.add(gi);
      continue;
    }
    // align runs over the segment's FULL word list (deleted words included → restore works)
    const consumed = new Set<number>(); // local indices kept
    let wi = 0;
    for (const run of parsed.runs) {
      const start = wi;
      wi = consumeRun(segWords, wi, run, parsed.line);
      if (!run.struck) for (let k = start; k < wi; k++) consumed.add(k);
    }
    canon.wordGis.forEach((gi, k) => {
      if (!consumed.has(k)) desiredDeleted.add(gi);
    });
  }
  // segments already fully deleted (not serialized) stay deleted
  for (const gi of currentDeleted) {
    const inCanon = canonRows.some((r) => r.wordGis.includes(gi));
    if (!inCanon) desiredDeleted.add(gi);
  }
  const removeWhole = desiredDeleted.size >= words.length;
  const toDelete = [...desiredDeleted].filter((gi) => !currentDeleted.has(gi));
  const toRestore = [...currentDeleted].filter((gi) => !desiredDeleted.has(gi));
  return { item, toDelete, toRestore, removeWhole };
}

/** diff an edited timeline.md against the live state and commit via commands.
 * Plans everything first; only dispatches when the whole script is valid. */
export function applyScript(getState: () => TimelineState, commands: Cmds, md: string, options: ApplyScriptOptions = {}): ApplyResult {
  const base = getState();
  const parsed = parseScript(md);
  if (options.trackId && parsed.trackId && options.trackId !== parsed.trackId) {
    throw new Error('timeline.md 的轨道作用域与 apply_script 指定轨道不一致');
  }
  const trackId = options.trackId ?? parsed.trackId ?? undefined;
  const { model, stamp } = serializeTimeline(base, { trackId, showSilence: parsed.showSilence });
  if (!parsed.stamp) throw new Error('缺少 script-stamp 注释——请保留 read_script 输出顶部的注释行');
  if (parsed.stamp !== stamp) throw new Error('时间线已被外部修改（stale）——请重新 read_script 后再改');

  const items = itemById(base);
  const removed: string[] = [];
  const changes: string[] = [];
  const wordPlans: WordPlan[] = [];
  const silencePlans: { row: SilenceRow; maxMs: number | null }[] = [];
  const removeIds: string[] = [];
  // per track: ordered tokens for the repack pass
  type Token = { kind: 'gap'; frames: number } | { kind: 'item'; id: string };
  const repack: { track: string; tokens: Token[] }[] = [];

  for (const canonTrack of model) {
    const parsedTrack = parsed.tracks.find((t) => t.track === canonTrack.track);
    if (!parsedTrack) throw new Error(`缺少 ## ${canonTrack.track} 轨道段——删空轨道请显式删除行，不要删掉整段`);

    // canonical lookups for this track
    const canonSegByItem = new Map<string, SegRow[]>();
    const clipByKey = new Map<string, Row & { kind: 'clip' }>();
    const silenceBySource = new Map<string, SilenceRow[]>();
    for (const region of canonTrack.regions) {
      for (const row of region.rows) {
        if (row.kind === 'seg') {
          const list = canonSegByItem.get(row.itemId) ?? [];
          list.push(row);
          canonSegByItem.set(row.itemId, list);
        } else if (row.kind === 'clip') {
          clipByKey.set(`${region.source}#c${row.cn}`, row);
        } else if (row.kind === 'silence') {
          const list = silenceBySource.get(region.source) ?? [];
          list.push(row);
          silenceBySource.set(region.source, list);
        }
      }
    }
    // transcript source → itemId (v1: one transcript item per source name per track)
    const transcriptItemBySource = new Map<string, string>();
    for (const [itemId] of canonSegByItem) {
      const it = items.get(itemId)!;
      if (transcriptItemBySource.has(it.name)) throw new Error(`同轨有两个同名口播素材「${it.name}」——v1 暂不支持（先重命名素材）`);
      transcriptItemBySource.set(it.name, itemId);
    }

    // walk parsed rows: collect word edits + structural tokens
    const tokens: Token[] = [];
    const seenItems = new Set<string>();
    const parsedSegByItem = new Map<string, ParsedSegRow[]>();
    for (const region of parsedTrack.regions) {
      if (parsed.showSilence) {
        const canonical = silenceBySource.get(region.source) ?? [];
        const edited = region.rows.filter((row): row is ParsedSilenceRow => row.kind === 'silence');
        if (edited.length !== canonical.length) {
          throw new Error(`「${region.source}」: silence 标记数量已改变——请保留标记并用 ~~...~~ 删除或用 → 压缩`);
        }
        edited.forEach((row, index) => {
          const canon = canonical[index]!;
          if (Math.abs(row.originalMs - canon.originalMs) > 1) {
            throw new Error(`timeline.md 第 ${row.line} 行: silence 原始时长与源口播不一致`);
          }
          const desired = row.struck ? 0 : row.targetMs;
          if (desired === undefined) {
            if (canon.appliedMs !== canon.originalMs) silencePlans.push({ row: canon, maxMs: null });
          } else if (Math.abs(desired - canon.appliedMs) > 1) {
            silencePlans.push({ row: canon, maxMs: Math.min(canon.originalMs, Math.max(0, desired)) });
          }
        });
      }
      for (const row of region.rows) {
        if (row.kind === 'gap') {
          if (!row.struck) tokens.push({ kind: 'gap', frames: row.frames });
          else removed.push(`[gap ${row.frames}f]`);
        } else if (row.kind === 'clip') {
          const canon = clipByKey.get(`${region.source}#c${row.cn}`);
          if (!canon) throw new Error(`timeline.md 第 ${row.line} 行: [c${row.cn}] 不在「${region.source}」下（新增片段请用 add 工具）`);
          if (row.struck) {
            removeIds.push(canon.itemId);
            removed.push(`${region.source} [c${row.cn}]`);
          } else if (!seenItems.has(canon.itemId)) {
            seenItems.add(canon.itemId);
            tokens.push({ kind: 'item', id: canon.itemId });
          }
        } else if (row.kind === 'seg') {
          const itemId = transcriptItemBySource.get(region.source);
          if (!itemId) throw new Error(`timeline.md 第 ${row.line} 行: 「${region.source}」不是本轨的口播素材`);
          const list = parsedSegByItem.get(itemId) ?? [];
          list.push(row);
          parsedSegByItem.set(itemId, list);
          if (!row.struck && !seenItems.has(itemId)) {
            seenItems.add(itemId);
            tokens.push({ kind: 'item', id: itemId });
          }
        }
      }
    }
    // plan word edits per transcript item (absent items → whole-item delete)
    for (const [itemId, canonRows] of canonSegByItem) {
      const plan = planSegRows(items.get(itemId)!, canonRows, parsedSegByItem.get(itemId) ?? []);
      if (plan.removeWhole) {
        removeIds.push(itemId);
        removed.push(`${plan.item.name}（整段口播）`);
      } else {
        if (plan.toDelete.length) changes.push(`${plan.item.name}: 删 ${plan.toDelete.length} 词`);
        if (plan.toRestore.length) changes.push(`${plan.item.name}: 恢复 ${plan.toRestore.length} 词`);
        wordPlans.push(plan);
      }
    }
    // non-transcript clips missing entirely (row deleted, not struck) → removed
    for (const [key, row] of clipByKey) {
      const represented = parsedTrack.regions.some((rg) => rg.rows.some((r) => r.kind === 'clip' && `${rg.source}#c${r.cn}` === key));
      if (!represented && !removeIds.includes(row.itemId)) {
        removeIds.push(row.itemId);
        removed.push(key.replace('#', ' '));
      }
    }
    repack.push({ track: canonTrack.track, tokens: tokens.filter((t) => t.kind === 'gap' || !removeIds.includes(t.id)) });
  }

  // ── everything validated: dispatch ──
  for (const plan of wordPlans) {
    if (plan.toDelete.length) commands.deleteWords(plan.item.id, plan.toDelete);
    for (const gi of plan.toRestore) commands.toggleWord(plan.item.id, gi);
  }
  for (const plan of silencePlans) {
    commands.setGapCap(plan.row.itemId, plan.row.afterWordIndex, plan.maxMs);
    changes.push(`${items.get(plan.row.itemId)?.name ?? plan.row.itemId}: 调整停顿`);
  }
  for (const id of removeIds) commands.removeItem(id);
  // repack: body order = playback order; frames re-derived from live durations
  for (const { tokens } of repack) {
    let cursor = 0;
    for (const tok of tokens) {
      if (tok.kind === 'gap') {
        cursor += tok.frames;
        continue;
      }
      const live = getState().items.find((it) => it.id === tok.id);
      if (!live) continue;
      if (live.startFrame !== cursor) {
        commands.moveItem(tok.id, { startFrame: cursor });
        changes.push(`${live.name}: 移到 ${cursor}f`);
      }
      cursor += live.durationInFrames;
    }
  }
  return { ok: true, removed, changes };
}
