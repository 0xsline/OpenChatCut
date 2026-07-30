import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import { ASPECT_PRESETS, type AspectPreset, type TimelineItem } from '../../editor/types';
import { msToFrame, type TranscriptWord } from '../../transcript/types';
import { generateAgentText } from '../client';

// find_highlights —— 智能切片 / 长转短成片口。
//
// "clip/highlight extraction / cut slices / make a short version" 本质是转写编辑
// 工作流(哪些词的语义决定播什么),而非一条原子命令。实现路径:LLM 读转写打分 →
// 批量短视频序列。因此:
//   · 工具名为 find_highlights;
//   · 高光判定标准复用 talking-head-guide 的规则(见 SELECT_SYSTEM);
//   · 长转短复用既有基础设施 duplicateTimeline({retarget}) + ASPECT_PRESETS(与
//     timeline-tools.ts 长转短完全同一路径),不另造重定位;
//   · 裁到高光帧区间时,转写 clip 走"删文本=删视频"(deleteWords)以保持词帧一致，
//     非转写 clip 走帧级 setItemTiming/removeItem。

type Args = Record<string, unknown>;

/** LLM 挑出的一段高光:一段连续的词区间(含端点)+ 标题/理由。 */
export interface Highlight {
  startWordIndex: number;
  endWordIndex: number;
  title: string;
  reason?: string;
}

/** 发给 LLM 的紧凑词条(索引对齐原转写下标,不可裁剪否则错位)。 */
interface WordRef {
  i: number;
  t: string;
  start: number; // ms
  end: number; // ms
}

interface SelectOpts {
  count: number;
  topic?: string;
  instruction?: string;
}

export const HIGHLIGHT_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'find_highlights',
    description:
      '智能切片(长转短成片):读取时间线上已转写视频的逐词稿,由 LLM 挑出最精彩、能独立成篇的高光片段,每段复制出一条竖屏短视频序列(默认 9:16)并裁到该高光的帧区间。片段需先转写(transcribe_track)。返回每条短视频的序列 id/标题/帧区间。LLM 失败时回退启发式(信息密度分块)。',
    input_schema: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: '要生成的短视频数量(默认 3)。' },
        ratio: { type: 'string', enum: ['9:16', '16:9', '1:1', '4:3', '3:4'], description: '短视频画布比例(默认 9:16)。' },
        topic: { type: 'string', description: '可选:只挑与该话题相关的高光。' },
        instruction: { type: 'string', description: '可选:额外挑选偏好(如"最有情绪冲突的""含数据点的")。' },
        itemId: { type: 'string', description: '可选:指定已转写的 video/audio clip(默认词数最多的那条)。' },
        minSeconds: { type: 'number', description: '每段最短秒数(默认 3)。' },
        maxSeconds: { type: 'number', description: '每段最长秒数(默认 60)。' },
      },
    },
  },
];

export const HIGHLIGHT_TOOL_NAMES = new Set(HIGHLIGHT_TOOL_SCHEMAS.map((t) => t.name));

// 高光判定标准——talking-head-guide.md 规则。
const SELECT_SYSTEM = `你是短视频剪辑师,从一段口播的逐词转写里挑出最适合做成独立竖屏短视频的高光片段。
判定亮点:观点、结论、故事、情绪、冲突、教程步骤、数据点,或某个指定话题。
- 每个亮点必须能被独立理解:保留理解它所需的主语、铺垫、问题与结论,别砍掉上下文。
- 若某句短促有力的话依赖前后语境才成立,就连语境一起保留,别只留那一句。
- 用户若指定话题,只挑该话题;若要"最精彩",优先信息密度与表达力度。
- 每段是连续的一段词(startWordIndex..endWordIndex,含端点),片段之间不得重叠。
只输出严格 JSON 数组(不要解释、不要 markdown 围栏):
[{"startWordIndex":整数,"endWordIndex":整数,"title":"短标题","reason":"为何精彩"}]`;

// ── LLM 选段(可被 setHighlightSelector 替换成 stub 以离线自检)──────────────
type HighlightSelector = (words: WordRef[], opts: SelectOpts) => Promise<unknown>;

/** 生产路径:真调 LLM,返回解析后的原始数组(未校验,视为不可信)。 */
async function llmSelectHighlights(words: WordRef[], opts: SelectOpts): Promise<unknown> {
  const list = words.map((w) => `${w.i}:${w.t}`).join(' ');
  const bias = [
    opts.topic ? `只挑与话题「${opts.topic}」相关的片段。` : '',
    opts.instruction ? `额外偏好:${opts.instruction}` : '',
  ].join('');
  const user = `逐词转写(共 ${words.length} 词,格式 序号:词):\n${list}\n\n挑出最多 ${opts.count} 段高光。${bias}`;
  const text = (await generateAgentText({
    maxOutputTokens: 8192,
    system: SELECT_SYSTEM,
    prompt: user,
  })).trim();
  return parseJsonArray(text);
}

let selector: HighlightSelector = llmSelectHighlights;
/** 仅供 .check 用:注入离线选段 stub;传 null 还原真 LLM 路径。 */
export function setHighlightSelector(fn: HighlightSelector | null): void {
  selector = fn ?? llmSelectHighlights;
}

/** 从模型文本里抠出第一个 JSON 数组并解析;失败抛错(交由上层转成 error)。 */
function parseJsonArray(text: string): unknown {
  const cleaned = text.replace(/^\s*```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('模型输出里没有 JSON 数组');
  return JSON.parse(cleaned.slice(start, end + 1));
}

export interface ValidateHighlightOpts {
  max: number;
  /** Word-level duration filter using transcript ms (inclusive indices). */
  words?: Array<{ start: number; end: number }>;
  minMs?: number;
  maxMs?: number;
}

/**
 * 校验并清洗 LLM 输出(不可信):丢弃非整数/越界/start>end 的条目,按起点排序后去重叠
 * (重叠段只保留先出现的),最多取 max 段。可选按时长过滤。导出以便直接单测拒绝越界/重叠。
 */
export function validateHighlights(
  raw: unknown,
  wordCount: number,
  maxOrOpts: number | ValidateHighlightOpts,
): Highlight[] {
  const opts: ValidateHighlightOpts = typeof maxOrOpts === 'number'
    ? { max: maxOrOpts }
    : maxOrOpts;
  const max = opts.max;
  if (!Array.isArray(raw)) return [];
  const cleaned: Highlight[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    const s = o.startWordIndex;
    const en = o.endWordIndex;
    if (!Number.isInteger(s) || !Number.isInteger(en)) continue;
    const si = s as number;
    const ei = en as number;
    if (si < 0 || ei < 0 || si >= wordCount || ei >= wordCount || si > ei) continue;
    if (opts.words && (opts.minMs != null || opts.maxMs != null)) {
      const startMs = opts.words[si]?.start ?? 0;
      const endMs = opts.words[ei]?.end ?? startMs;
      const dur = Math.max(0, endMs - startMs);
      if (opts.minMs != null && dur < opts.minMs) continue;
      if (opts.maxMs != null && dur > opts.maxMs) {
        // Shrink end index until under maxMs (keep start).
        let e2 = ei;
        while (e2 > si && (opts.words[e2].end - startMs) > opts.maxMs) e2 -= 1;
        if ((opts.words[e2].end - startMs) < (opts.minMs ?? 0)) continue;
        const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : `精彩片段 ${cleaned.length + 1}`;
        cleaned.push({
          startWordIndex: si,
          endWordIndex: e2,
          title,
          reason: typeof o.reason === 'string' ? o.reason : undefined,
        });
        continue;
      }
    }
    const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : `精彩片段 ${cleaned.length + 1}`;
    cleaned.push({ startWordIndex: si, endWordIndex: ei, title, reason: typeof o.reason === 'string' ? o.reason : undefined });
  }
  cleaned.sort((a, b) => a.startWordIndex - b.startWordIndex || a.endWordIndex - b.endWordIndex);
  const out: Highlight[] = [];
  let lastEnd = -1;
  for (const h of cleaned) {
    if (h.startWordIndex <= lastEnd) continue; // 与已保留区间重叠 → 丢弃
    out.push(h);
    lastEnd = h.endWordIndex;
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Heuristic fallback when LLM is unavailable: split transcript into non-overlapping
 * windows by information density (chars / second) and take top-N.
 */
export function heuristicHighlights(
  words: WordRef[],
  count: number,
  minMs = 3000,
  maxMs = 60_000,
): Highlight[] {
  if (!words.length || count <= 0) return [];
  const totalMs = Math.max(1, words[words.length - 1].end - words[0].start);
  const windowMs = Math.min(maxMs, Math.max(minMs, Math.round(totalMs / Math.max(count, 1))));
  const candidates: Array<Highlight & { score: number }> = [];
  let i = 0;
  while (i < words.length) {
    const startMs = words[i].start;
    let j = i;
    while (j + 1 < words.length && words[j + 1].end - startMs <= windowMs) j += 1;
    const endMs = words[j].end;
    const dur = Math.max(1, endMs - startMs);
    if (dur >= minMs * 0.8) {
      const text = words.slice(i, j + 1).map((w) => w.t).join('');
      // Density + mild bonus for longer intact phrases / punctuation energy
      const score = (text.length / (dur / 1000))
        + ( /[?!？！]/.test(text) ? 8 : 0)
        + ( /\d/.test(text) ? 4 : 0);
      const title = text.replace(/\s+/g, ' ').trim().slice(0, 24) || `片段 ${candidates.length + 1}`;
      candidates.push({
        startWordIndex: i,
        endWordIndex: j,
        title,
        reason: 'heuristic density',
        score,
      });
    }
    // Advance with slight overlap avoid: jump past mid window
    const mid = Math.max(i + 1, Math.floor((i + j) / 2) + 1);
    i = j >= i ? Math.max(j + 1, mid) : i + 1;
  }
  candidates.sort((a, b) => b.score - a.score);
  // Re-sort by time and de-overlap greedily by score order
  const picked: Highlight[] = [];
  const used = new Array(words.length).fill(false);
  for (const c of candidates) {
    let overlap = false;
    for (let k = c.startWordIndex; k <= c.endWordIndex; k++) {
      if (used[k]) { overlap = true; break; }
    }
    if (overlap) continue;
    for (let k = c.startWordIndex; k <= c.endWordIndex; k++) used[k] = true;
    picked.push({
      startWordIndex: c.startWordIndex,
      endWordIndex: c.endWordIndex,
      title: c.title,
      reason: c.reason,
    });
    if (picked.length >= count) break;
  }
  picked.sort((a, b) => a.startWordIndex - b.startWordIndex);
  return picked;
}

/** 时间线上"主内容":带转写的音/视频 clip 里词数最多的一条(视频优先)。 */
function pickTranscribedItem(items: TimelineItem[], itemId?: string): TimelineItem | null {
  if (itemId) {
    const q = itemId;
    const hit = items.find((it) => (it.id === q || it.id.startsWith(q))
      && (it.kind === 'video' || it.kind === 'audio')
      && (it.transcript?.length ?? 0) > 0);
    if (hit) return hit;
  }
  const scored = items
    .filter((it) => (it.kind === 'video' || it.kind === 'audio') && (it.transcript?.length ?? 0) > 0)
    .map((it) => ({ it, score: (it.transcript!.length) + (it.kind === 'video' ? 100000 : 0) }));
  if (!scored.length) return null;
  return scored.reduce((best, cur) => (cur.score > best.score ? cur : best)).it;
}

export interface Short {
  timelineId: string;
  title: string;
  startFrame: number;
  endFrame: number;
  ratio: string;
}

/**
 * 把每段高光落成一条短视频序列:复制原序列并重定位到目标画布,切到高光帧区间。
 * 转写 clip 走 deleteWords 以保持词帧一致，其余 clip 走帧级裁剪。返回落成的短视频清单。
 */
export function assembleShorts(
  ctx: AgentContext,
  srcTimelineId: string,
  item: TimelineItem,
  highlights: Highlight[],
  preset: AspectPreset,
): Short[] {
  const words = item.transcript!;
  const fps = ctx.getState().fps;
  const shorts: Short[] = [];
  for (const hl of highlights) {
    const spanStart = item.startFrame + msToFrame(words[hl.startWordIndex].start, fps);
    const rawEnd = item.startFrame + msToFrame(words[hl.endWordIndex].end, fps);
    const spanEnd = Math.max(rawEnd, spanStart + 1); // 至少 1 帧
    const copyId = ctx.commands.duplicateTimeline(srcTimelineId, {
      name: hl.title,
      retarget: { width: preset.width, height: preset.height, fit: 'cover' },
      activate: false,
    });
    ctx.commands.switchTimeline(copyId); // 逐 clip 命令只作用于 active 序列 → 先切到副本
    trimCopyToHighlight(ctx, item.id, words.length, hl, spanStart, spanEnd);
    shorts.push({ timelineId: copyId, title: hl.title, startFrame: spanStart, endFrame: spanEnd, ratio: preset.label });
  }
  return shorts;
}

/** 在当前 active 副本上,把 [spanStart,spanEnd) 之外的内容全部裁掉,并把区间平移到 0。 */
function trimCopyToHighlight(
  ctx: AgentContext,
  transcribedId: string,
  wordCount: number,
  hl: Highlight,
  spanStart: number,
  spanEnd: number,
): void {
  const snapshot = [...ctx.getState().items]; // 先快照:后续编辑不改其它 clip 的绝对帧位

  // 1) 转写 clip:删掉高光之外的词("删文本=删视频",词↔帧一致由该机制保证),
  //    保留词按序播放,再整体平移到帧 0 让短视频从高光开头起播。
  const outside: number[] = [];
  for (let i = 0; i < wordCount; i++) if (i < hl.startWordIndex || i > hl.endWordIndex) outside.push(i);
  if (outside.length) ctx.commands.deleteWords(transcribedId, outside);
  ctx.commands.moveItem(transcribedId, { startFrame: 0 });

  // 2) 其余 clip:与 [spanStart,spanEnd) 求交——无交叠删除,有交叠裁剪并平移 -spanStart。
  for (const it of snapshot) {
    if (it.id === transcribedId) continue;
    const itemEnd = it.startFrame + it.durationInFrames;
    const oStart = Math.max(it.startFrame, spanStart);
    const oEnd = Math.min(itemEnd, spanEnd);
    if (oEnd <= oStart) {
      ctx.commands.removeItem(it.id);
      continue;
    }
    const leftTrim = oStart - it.startFrame;
    // 有源媒体(视频/音频)左裁需同步推进 srcInFrame;MG/文字无源,时间轴动画随起点走。
    // ponytail: MG 被头部裁剪会丢开场动画,短视频场景可接受。
    ctx.commands.setItemTiming(it.id, {
      startFrame: oStart - spanStart,
      durationInFrames: oEnd - oStart,
      srcInFrame: it.src ? (it.srcInFrame ?? 0) + leftTrim : undefined,
    });
  }
}

export async function execHighlightTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'find_highlights') return { error: `unknown tool ${name}` };

  const doc = ctx.getDoc();
  const originalActiveId = doc.activeTimelineId;
  const srcTimelineId = originalActiveId;

  const item = pickTranscribedItem(
    ctx.getState().items,
    typeof args.itemId === 'string' ? args.itemId : undefined,
  );
  if (!item?.transcript?.length) {
    return { error: '当前时间线没有已转写的视频/音频片段;请先用 transcribe_track 转写,再智能切片。' };
  }

  const ratio = typeof args.ratio === 'string' ? args.ratio : '9:16';
  const preset = ASPECT_PRESETS.find((p) => p.label === ratio);
  if (!preset) return { error: `unknown ratio ${ratio}(可选 ${ASPECT_PRESETS.map((p) => p.label).join('/')})` };
  const count = Number.isInteger(args.count) && (args.count as number) > 0 ? (args.count as number) : 3;
  // Duration bounds only when caller opts in (default leaves short LLM picks intact).
  const hasMin = Number.isFinite(Number(args.minSeconds));
  const hasMax = Number.isFinite(Number(args.maxSeconds));
  const minSeconds = hasMin ? Math.max(0.5, Number(args.minSeconds)) : undefined;
  const maxSeconds = hasMax
    ? Math.max(minSeconds ?? 0.5, Number(args.maxSeconds))
    : undefined;
  const minMs = minSeconds != null ? Math.round(minSeconds * 1000) : undefined;
  const maxMs = maxSeconds != null ? Math.round(maxSeconds * 1000) : undefined;

  const words: WordRef[] = item.transcript.map((w: TranscriptWord, i) => ({ i, t: w.text, start: w.start, end: w.end }));

  let raw: unknown;
  let source: 'llm' | 'heuristic' = 'llm';
  try {
    raw = await selector(words, {
      count,
      topic: typeof args.topic === 'string' ? args.topic : undefined,
      instruction: typeof args.instruction === 'string' ? args.instruction : undefined,
    });
  } catch {
    raw = null;
  }

  let highlights = validateHighlights(raw, words.length, {
    max: count,
    words: (minMs != null || maxMs != null) ? words : undefined,
    minMs,
    maxMs,
  });
  if (!highlights.length) {
    source = 'heuristic';
    highlights = heuristicHighlights(
      words,
      count,
      minMs ?? 1000,
      maxMs ?? 60_000,
    );
  }
  if (!highlights.length) {
    ctx.commands.switchTimeline(originalActiveId);
    return { error: '未能从转写里选出可用的高光片段(模型输出为空且启发式也无候选)。' };
  }

  const shorts = assembleShorts(ctx, srcTimelineId, item, highlights, preset);
  ctx.commands.switchTimeline(originalActiveId); // 还原用户视图到原序列(duplicate 用 activate:false)

  return {
    ok: true,
    sourceItemId: item.id,
    count: shorts.length,
    shorts,
    selector: source,
    ...(minSeconds != null || maxSeconds != null
      ? { durationBounds: { minSeconds: minSeconds ?? null, maxSeconds: maxSeconds ?? null } }
      : {}),
  };
}
