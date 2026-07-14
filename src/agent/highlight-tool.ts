import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from './context';
import { ASPECT_PRESETS, type AspectPreset, type TimelineItem } from '../editor/types';
import { msToFrame, type TranscriptWord } from '../transcript/types';
import { createMessage, MODEL } from './client';

// find_highlights —— 智能切片 / 长转短成片口。
//
// 源站无据,自定(CLAUDE.md 对标规则 5):逆向资料里没有单一命名的"找高光/自动切片"
// 工具。`harness/mcp-tools-schema.md` 明确把 "clip/highlight extraction / cut slices /
// make a short version" 归入 Script 系统的**转写编辑工作流**(哪些词的语义决定播什么),
// 而非一条原子命令;audit(reports/…/feature-gap-matrix.md)也把"智能切片(按转写找高光→
// 多条短视频)"列为未实现,给出复刻路径"LLM 读转写打分 → 批量短视频序列"。因此:
//   · 工具名自定为 find_highlights;
//   · 高光判定标准直接复用源站 talking-head-guide 的原文规则(见 SELECT_SYSTEM);
//   · 长转短复用既有基础设施 duplicateTimeline({retarget}) + ASPECT_PRESETS(与
//     timeline-tools.ts 长转短完全同一路径),不另造重定位;
//   · 裁到高光帧区间时,转写 clip 走源站"删文本=删视频"(deleteWords)以守住护城河③
//     (词↔帧一致),非转写 clip 走帧级 setItemTiming/removeItem。

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

export const HIGHLIGHT_TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'find_highlights',
    description:
      '智能切片(长转短成片):读取时间线上已转写视频的逐词稿,由 LLM 挑出最精彩、能独立成篇的高光片段,每段复制出一条竖屏短视频序列(默认 9:16)并裁到该高光的帧区间。片段需先转写(transcribe_track)。返回每条短视频的序列 id/标题/帧区间。',
    input_schema: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: '要生成的短视频数量(默认 3)。' },
        ratio: { type: 'string', enum: ['9:16', '16:9', '1:1', '4:3', '3:4'], description: '短视频画布比例(默认 9:16)。' },
        topic: { type: 'string', description: '可选:只挑与该话题相关的高光。' },
        instruction: { type: 'string', description: '可选:额外挑选偏好(如"最有情绪冲突的""含数据点的")。' },
      },
    },
  },
];

export const HIGHLIGHT_TOOL_NAMES = new Set(HIGHLIGHT_TOOL_SCHEMAS.map((t) => t.name));

// 高光判定标准——源站 talking-head-guide.md 原文规则(复用,非自造)。
const SELECT_SYSTEM = `你是短视频剪辑师,从一段口播的逐词转写里挑出最适合做成独立竖屏短视频的高光片段。
判定亮点(源站规则):观点、结论、故事、情绪、冲突、教程步骤、数据点,或某个指定话题。
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
  const msg = await createMessage({
    model: MODEL,
    max_tokens: 8192,
    system: SELECT_SYSTEM,
    messages: [{ role: 'user', content: user }],
  });
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
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

/**
 * 校验并清洗 LLM 输出(不可信):丢弃非整数/越界/start>end 的条目,按起点排序后去重叠
 * (重叠段只保留先出现的),最多取 max 段。导出以便直接单测拒绝越界/重叠。
 */
export function validateHighlights(raw: unknown, wordCount: number, max: number): Highlight[] {
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

/** 时间线上"主内容":带转写的音/视频 clip 里词数最多的一条(视频优先)。 */
function pickTranscribedItem(items: TimelineItem[]): TimelineItem | null {
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
 * 转写 clip 走 deleteWords(护城河③),其余 clip 走帧级裁剪。返回落成的短视频清单。
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

  // 1) 转写 clip:删掉高光之外的词(源站"删文本=删视频",词↔帧一致由该机制保证),
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

  const item = pickTranscribedItem(ctx.getState().items);
  if (!item?.transcript?.length) {
    return { error: '当前时间线没有已转写的视频/音频片段;请先用 transcribe_track 转写,再智能切片。' };
  }

  const ratio = typeof args.ratio === 'string' ? args.ratio : '9:16';
  const preset = ASPECT_PRESETS.find((p) => p.label === ratio);
  if (!preset) return { error: `unknown ratio ${ratio}(可选 ${ASPECT_PRESETS.map((p) => p.label).join('/')})` };
  const count = Number.isInteger(args.count) && (args.count as number) > 0 ? (args.count as number) : 3;

  const words: WordRef[] = item.transcript.map((w: TranscriptWord, i) => ({ i, t: w.text, start: w.start, end: w.end }));

  let raw: unknown;
  try {
    raw = await selector(words, { count, topic: typeof args.topic === 'string' ? args.topic : undefined, instruction: typeof args.instruction === 'string' ? args.instruction : undefined });
  } catch (e) {
    return { error: `高光选段失败: ${e instanceof Error ? e.message : String(e)}` };
  }

  const highlights = validateHighlights(raw, words.length, count);
  if (!highlights.length) {
    ctx.commands.switchTimeline(originalActiveId);
    return { error: '未能从转写里选出可用的高光片段(模型输出为空或全部无效)。' };
  }

  const shorts = assembleShorts(ctx, srcTimelineId, item, highlights, preset);
  ctx.commands.switchTimeline(originalActiveId); // 还原用户视图到原序列(duplicate 用 activate:false)

  return { ok: true, sourceItemId: item.id, count: shorts.length, shorts };
}
