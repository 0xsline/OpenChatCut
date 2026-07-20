import type { AgentContext } from '../context';
import { resolveTrackId, trackAlias, type TimelineItem, type TimelineState } from '../../editor/types';
import { itemWindow, keptSegments, type EditOpts } from '../../transcript/edit';
import { msToFrame, type TranscriptWord } from '../../transcript/types';

// find_transcript — 参数面:query(必填) + asset / track / fuzzy /
// includeWordTimestamps / limit。时间坐标查询器:定位一句话何时被说出,把
// B-roll/MG/marker/overlay 锚到那一刻。timeline 模式尊重剪辑(删词不再命中);
// asset 模式查资产 RAW 转写(库查询,无视剪辑)。词→帧换算与播放层共用
// keptSegments 以保持词帧一致。markers 的 transcriptSegments 也复用
// makeWordFrameMapper,两处锚定语义恒一致。

type Args = Record<string, unknown>;

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
/** fuzzy 模式:相邻 query token 间最多容忍多少个非 query 词(填充词 "uh," 等)。 */
const FUZZY_MAX_SKIP = 3;

export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, ' ').trim();
}

/** Locate a phrase in a word list; returns the first covering [start, start+count) run. */
export function findPhrase(words: TranscriptWord[], query: string): { start: number; count: number } | null {
  const q = normalize(query);
  if (!q) return null;
  let joined = '';
  const charWord: number[] = [];
  words.forEach((w, i) => {
    const t = normalize(w.text);
    if (!t) return;
    if (joined) { joined += ' '; charWord.push(-1); }
    for (const ch of t) { joined += ch; charWord.push(i); }
  });
  const pos = joined.indexOf(q);
  if (pos < 0) return null;
  const s = charWord[pos];
  const e = charWord[pos + q.length - 1];
  if (s === undefined || e === undefined || s < 0 || e < 0) return null;
  return { start: s, count: e - s + 1 };
}

// ── 词→时间轴帧映射(与 TimelineComposition 播放层同一套 keptSegments 数学)──

/** 一个 clip 的词级帧映射:gi → 时间轴 {fromFrame,toFrame};删掉/被压缩掉的词 → null。 */
export function makeWordFrameMapper(item: TimelineItem, fps: number): (gi: number) => { fromFrame: number; toFrame: number } | null {
  const words = item.transcript ?? [];
  const deleted = new Set(item.deletedWordIdx ?? []);
  const opts: EditOpts = {
    maxGapFrames: item.silenceFrames, gapCapsMs: item.gapCapsMs, playOrder: item.transcriptPlayOrder,
    window: itemWindow(item), // trim 掉的词不再产出帧位(与播放层一致)
  };
  const segs = keptSegments(words, deleted, fps, item.startFrame, opts);
  return (gi: number) => {
    const w = words[gi];
    if (!w || deleted.has(gi)) return null;
    const wS = msToFrame(w.start, fps);
    const wE = msToFrame(w.end, fps);
    const seg = segs.find((s) => wS >= s.srcStartFrame && wS < s.srcEndFrame)
      ?? segs.find((s) => wS <= s.srcEndFrame && wE >= s.srcStartFrame);
    if (!seg) return null;
    const fromFrame = seg.fromFrame + (Math.max(wS, seg.srcStartFrame) - seg.srcStartFrame);
    const toFrame = seg.fromFrame + (Math.min(wE, seg.srcEndFrame) - seg.srcStartFrame);
    return { fromFrame, toFrame: Math.max(fromFrame, toFrame) };
  };
}

// ── 匹配器(默认连续匹配 / fuzzy token 滑窗)──

interface SearchWord { gi: number; text: string; norm: string; start: number; end: number }
interface MatchPos { from: number; to: number } // positions in the SearchWord view

function searchView(words: TranscriptWord[], deleted?: Set<number>): SearchWord[] {
  const out: SearchWord[] = [];
  words.forEach((w, gi) => {
    if (deleted?.has(gi)) return;
    out.push({ gi, text: w.text, norm: normalize(w.text), start: w.start, end: w.end });
  });
  return out;
}

/** 默认匹配:大小写/标点/空白不敏感的连续匹配,返回全部(不重叠)命中。 */
function contiguousMatches(view: SearchWord[], query: string, limit: number): MatchPos[] {
  const q = normalize(query);
  if (!q) return [];
  let joined = '';
  const charPos: number[] = [];
  view.forEach((w, pos) => {
    if (!w.norm) return;
    if (joined) { joined += ' '; charPos.push(-1); }
    for (const ch of w.norm) { joined += ch; charPos.push(pos); }
  });
  const out: MatchPos[] = [];
  let idx = joined.indexOf(q);
  while (idx >= 0 && out.length < limit) {
    const s = charPos[idx];
    const e = charPos[idx + q.length - 1];
    if (s !== undefined && e !== undefined && s >= 0 && e >= 0) out.push({ from: s, to: e });
    idx = joined.indexOf(q, idx + q.length);
  }
  return out;
}

/** fuzzy:query 按空白切 token,词序列上按序滑窗匹配,token 间容忍 ≤FUZZY_MAX_SKIP 个填充词。 */
function fuzzyMatches(view: SearchWord[], query: string, limit: number): MatchPos[] {
  const tokens = normalize(query).split(' ').filter(Boolean);
  if (!tokens.length) return [];
  const matchTok = (w: SearchWord, tok: string): boolean =>
    !!w.norm && (w.norm === tok || (tok.length > 1 && (w.norm.includes(tok) || tok.includes(w.norm))));
  const out: MatchPos[] = [];
  let pos = 0;
  while (pos < view.length && out.length < limit) {
    if (!matchTok(view[pos]!, tokens[0]!)) { pos += 1; continue; }
    let last = pos;
    let ok = true;
    for (let k = 1; k < tokens.length; k++) {
      let found = -1;
      const maxJ = Math.min(view.length - 1, last + 1 + FUZZY_MAX_SKIP);
      for (let j = last + 1; j <= maxJ; j++) {
        if (matchTok(view[j]!, tokens[k]!)) { found = j; break; }
      }
      if (found < 0) { ok = false; break; }
      last = found;
    }
    if (ok) { out.push({ from: pos, to: last }); pos = last + 1; }
    else pos += 1;
  }
  return out;
}

// ── find_transcript 执行器 ──

const round2 = (n: number): number => Math.round(n * 100) / 100;

interface FindOpts { query: string; fuzzy: boolean; includeWords: boolean; limit: number }

function parseFindOpts(args: Args): FindOpts | { error: string } {
  const query = String(args.query ?? '').trim();
  if (!query) return { error: 'query is required' };
  const rawLimit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : DEFAULT_LIMIT;
  return {
    query,
    fuzzy: args.fuzzy === true,
    includeWords: args.includeWordTimestamps === true,
    limit: Math.max(1, Math.min(rawLimit, MAX_LIMIT)),
  };
}

/** timeline 模式一条命中(帧坐标 + 可选 Words 块)。 */
function timelineMatchRow(state: TimelineState, it: TimelineItem, view: SearchWord[], m: MatchPos, opts: FindOpts, mapper: ReturnType<typeof makeWordFrameMapper>) {
  const span = view.slice(m.from, m.to + 1);
  const first = span[0]!;
  const last = span[span.length - 1]!;
  const f0 = mapper(first.gi);
  const f1 = mapper(last.gi);
  if (!f0 || !f1) return null;
  const fps = state.fps;
  return {
    itemId: it.id,
    track: trackAlias(state, it.track),
    text: span.map((w) => w.text).join(' '),
    wordStart: first.gi,
    wordCount: last.gi - first.gi + 1,
    fromFrame: f0.fromFrame,
    toFrame: f1.toFrame,
    ...(opts.includeWords ? {
      words: span.map((w) => {
        const f = mapper(w.gi);
        return f
          ? { text: w.text, fromFrame: f.fromFrame, toFrame: f.toFrame, startSeconds: round2(f.fromFrame / fps), endSeconds: round2(f.toFrame / fps) }
          : { text: w.text, fromFrame: null, toFrame: null, startSeconds: null, endSeconds: null };
      }),
    } : {}),
  };
}

/** asset 模式:查单资产的 RAW 转写(无视剪辑),返回源内秒坐标 + 时间轴摆放位置。 */
function findInAsset(assetQ: string, opts: FindOpts, ctx: AgentContext): unknown {
  const state = ctx.getState();
  const assets = ctx.getDoc().assets ?? state.assets ?? [];
  const exact = assets.filter((a) => a.id === assetQ);
  const cands = exact.length ? exact : assets.filter((a) => a.id.startsWith(assetQ));
  if (!cands.length) return { error: `no asset matching "${assetQ}" — pass an asset id or prefix from the media pool` };
  if (cands.length > 1) return { error: `asset prefix "${assetQ}" is ambiguous (${cands.map((a) => a.id.slice(0, 12)).join(', ')})` };
  const asset = cands[0]!;
  if (!asset.transcript?.length) return { error: `asset "${asset.name}" has no transcript` };

  const view = searchView(asset.transcript); // RAW:asset 模式无视剪辑
  const found = (opts.fuzzy ? fuzzyMatches : contiguousMatches)(view, opts.query, opts.limit);
  const matches = found.map((m) => {
    const span = view.slice(m.from, m.to + 1);
    const first = span[0]!;
    const last = span[span.length - 1]!;
    return {
      text: span.map((w) => w.text).join(' '),
      wordStart: first.gi,
      wordCount: last.gi - first.gi + 1,
      startSeconds: round2(first.start / 1000),
      endSeconds: round2(last.end / 1000),
      ...(opts.includeWords ? { words: span.map((w) => ({ text: w.text, startSeconds: round2(w.start / 1000), endSeconds: round2(w.end / 1000) })) } : {}),
    };
  });
  const placements = state.items
    .filter((it) => it.src === asset.src)
    .map((it) => ({ itemId: it.id, track: trackAlias(state, it.track) }));
  return matches.length
    ? { found: true, query: opts.query, mode: 'asset', asset: { id: asset.id, name: asset.name }, matchCount: matches.length, matches, placements }
    : { found: false, query: opts.query, mode: 'asset', asset: { id: asset.id, name: asset.name } };
}

/** find_transcript 主入口(transcript-tools.ts 委托到这)。 */
export function execFindTranscript(args: Args, ctx: AgentContext): unknown {
  const opts = parseFindOpts(args);
  if ('error' in opts) return opts;

  const assetQ = typeof args.asset === 'string' ? args.asset.trim() : '';
  if (assetQ) return findInAsset(assetQ, opts, ctx);

  const state = ctx.getState();
  let items = state.items.filter((it) => (it.transcript?.length ?? 0) > 0);
  const trackQ = typeof args.track === 'string' ? args.track.trim() : '';
  if (trackQ) {
    const trackId = resolveTrackId(state, trackQ);
    if (!trackId) return { error: `no track "${trackQ}"` };
    items = items.filter((it) => it.track === trackId);
  }
  items = [...items].sort((a, b) => a.startFrame - b.startFrame);
  if (!items.length) {
    return { error: trackQ ? `no transcript on ${trackQ}; call transcribe_track first` : 'no transcribed clip on the timeline; call transcribe_track first' };
  }

  const matches: NonNullable<ReturnType<typeof timelineMatchRow>>[] = [];
  for (const it of items) {
    if (matches.length >= opts.limit) break;
    const view = searchView(it.transcript!, new Set(it.deletedWordIdx ?? [])); // timeline 模式尊重剪辑
    const found = (opts.fuzzy ? fuzzyMatches : contiguousMatches)(view, opts.query, opts.limit - matches.length);
    const mapper = makeWordFrameMapper(it, state.fps);
    for (const m of found) {
      if (matches.length >= opts.limit) break;
      const row = timelineMatchRow(state, it, view, m, opts, mapper);
      if (row) matches.push(row);
    }
  }
  if (!matches.length) return { found: false, query: opts.query, ...(opts.fuzzy ? { fuzzy: true } : {}) };

  const first = matches[0]!;
  return {
    found: true,
    query: opts.query,
    matchCount: matches.length,
    matches,
    // 旧字段(向后兼容):首个命中平铺在顶层
    itemId: first.itemId,
    wordStart: first.wordStart,
    wordCount: first.wordCount,
    text: first.text,
    fromFrame: first.fromFrame,
    toFrame: first.toFrame,
  };
}
