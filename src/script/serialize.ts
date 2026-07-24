// timeline.md serialization for read_script.
// Format: `# Timeline` + script-stamp comment + `## <track>` sections +
// `### <source>` regions + rows: `[sN] sentence` (transcript segment, kept text
// only — NO word timing in the file), `[cN] Nf` (non-transcript clip),
// `[gap Nf]`. Body order = playback order; apply re-derives all frames.
import { timelineTrackIds, trackAlias, type TimelineItem, type TimelineState, type TrackId } from '../editor/types';
import { buildScriptRows, toSegments } from '../transcript/segment';

export interface SegRow {
  kind: 'seg';
  sn: number; // source-local segment id (1-based over the item's full transcript)
  itemId: string;
  /** global word indices of this segment (into item.transcript) */
  wordGis: number[];
  /** currently-kept words' text (what the row displays) */
  keptText: string;
}
export interface ClipRow { kind: 'clip'; cn: number; itemId: string; frames: number }
export interface GapRow { kind: 'gap'; frames: number }
export interface SilenceRow {
  kind: 'silence';
  itemId: string;
  /** Source-word index immediately after this pause. */
  afterWordIndex: number;
  originalMs: number;
  appliedMs: number;
}
export type Row = SegRow | ClipRow | GapRow | SilenceRow;

export interface Region { source: string; rows: Row[] }
export interface TrackModel { track: string; trackId: TrackId; regions: Region[] }
export interface SerializeTimelineOptions {
  trackId?: TrackId;
  showSilence?: boolean;
}

// join word tokens: space-separated except between CJK characters (Chinese lines without spaces)
const CJK = /[㐀-Yi豈-﫿]/;
export function joinWords(tokens: string[]): string {
  let out = '';
  for (const t of tokens) {
    if (out && !(CJK.test(out[out.length - 1]) && CJK.test(t[0]))) out += ' ';
    out += t;
  }
  return out;
}

/** canonical row model of a timeline — shared by serialize (render) and apply (diff base) */
export function buildModel(state: TimelineState, options: SerializeTimelineOptions = {}): TrackModel[] {
  const tracks: TrackModel[] = [];
  const trackIds = options.trackId ? [options.trackId] : timelineTrackIds(state);
  for (const trackId of trackIds) {
    const items = state.items.filter((it) => it.track === trackId).sort((a, b) => a.startFrame - b.startFrame);
    if (!items.length) continue;
    const regions: Region[] = [];
    let cursor = 0;
    // per-source [cN] counters (numbering is per source across the track)
    const cCount = new Map<string, number>();
    const push = (source: string, row: Row, freshRegion: boolean) => {
      const last = regions[regions.length - 1];
      if (!freshRegion && last && last.source === source) last.rows.push(row);
      else regions.push({ source, rows: [row] });
    };
    for (const it of items) {
      if (it.startFrame > cursor) {
        const gap: GapRow = { kind: 'gap', frames: it.startFrame - cursor };
        if (regions.length) regions[regions.length - 1].rows.push(gap);
        else regions.push({ source: it.name, rows: [gap] });
      }
      if (it.transcript?.length) {
        // a transcript item is always its own region → [sN] unambiguous per region
        const deleted = new Set(it.deletedWordIdx ?? []);
        const rows: Row[] = [];
        const silences = options.showSilence
          ? buildScriptRows(it.transcript, deleted, {
              fps: state.fps,
              gapCapsMs: it.gapCapsMs,
              silenceFrames: it.silenceFrames,
              playOrder: it.transcriptPlayOrder,
            }).filter((row) => row.kind === 'gap')
          : [];
        toSegments(it.transcript).forEach((seg, i) => {
          const kept = seg.words.filter((w) => !deleted.has(w.gi));
          if (!kept.length) return; // Fully deleted segments are omitted.
          // Silence markers are standalone rows in timeline.md. A sentence may
          // contain more than one pause. `afterWordGi` identifies the first word
          // after the pause, so emit the marker before the segment containing it.
          const wordIds = new Set(seg.words.map((word) => word.gi));
          for (const silence of silences) {
            if (!wordIds.has(silence.afterWordGi)) continue;
            rows.push({
              kind: 'silence',
              itemId: it.id,
              afterWordIndex: silence.afterWordGi,
              originalMs: silence.gapMs,
              appliedMs: silence.appliedMs,
            });
          }
          rows.push({ kind: 'seg', sn: i + 1, itemId: it.id, wordGis: seg.words.map((w) => w.gi), keptText: joinWords(kept.map((w) => w.text)) });
        });
        regions.push({ source: it.name, rows });
      } else {
        const cn = (cCount.get(it.name) ?? 0) + 1;
        cCount.set(it.name, cn);
        push(it.name, { kind: 'clip', cn, itemId: it.id, frames: it.durationInFrames }, false);
      }
      cursor = it.startFrame + it.durationInFrames;
    }
    tracks.push({ track: trackAlias(state, trackId), trackId, regions });
  }
  return tracks;
}

const seconds = (ms: number): string => {
  const value = Math.max(0, ms) / 1000;
  return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') || '0';
};

function renderBody(model: TrackModel[]): string {
  const lines: string[] = [];
  for (const t of model) {
    lines.push(`## ${t.track}`);
    for (const r of t.regions) {
      lines.push(`### ${r.source}`);
      for (const row of r.rows) {
        if (row.kind === 'seg') lines.push(`[s${row.sn}] ${row.keptText}`);
        else if (row.kind === 'clip') lines.push(`[c${row.cn}] ${row.frames}f`);
        else if (row.kind === 'gap') lines.push(`[gap ${row.frames}f]`);
        else {
          const original = seconds(row.originalMs);
          const applied = seconds(row.appliedMs);
          lines.push(Math.abs(row.originalMs - row.appliedMs) >= 1
            ? `[silence=${original}s→${applied}s]`
            : `[silence=${original}s]`);
        }
      }
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

// djb2 — stamp binds a script to the exact state it was materialized from
export function stampOf(body: string): string {
  let h = 5381;
  for (let i = 0; i < body.length; i++) h = ((h << 5) + h + body.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** state → timeline.md (read_script). Also returns the model + stamp. */
export function serializeTimeline(state: TimelineState, options: SerializeTimelineOptions = {}): { md: string; model: TrackModel[]; stamp: string } {
  const model = buildModel(state, options);
  const body = renderBody(model);
  const stamp = stampOf(body);
  const scope = options.trackId ? `\n<!-- script-track:${options.trackId} -->` : '';
  const silence = options.showSilence ? '\n<!-- script-silence:true -->' : '';
  const md = `# Timeline\n<!-- script-stamp:${stamp} -->${scope}${silence}\n<!-- script:body -->\n\n${body}`;
  return { md, model, stamp };
}

/** items indexed by id (helper for apply) */
export function itemById(state: TimelineState): Map<string, TimelineItem> {
  return new Map(state.items.map((it) => [it.id, it]));
}
