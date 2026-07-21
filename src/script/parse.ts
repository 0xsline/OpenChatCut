// Parse an edited timeline.md back into a row model: `~~...~~` marks a strike
// over a whole row or
// word runs inside a [sN] row), row deletion = same as strike, row order on
// disk = playback order. Fails fast with line numbers — the script text is
// untrusted agent output.

export interface ParsedRun { text: string; struck: boolean }
export interface ParsedSegRow { kind: 'seg'; sn: number; occurrence?: number; struck: boolean; runs: ParsedRun[]; line: number }
export interface ParsedClipRow { kind: 'clip'; cn: number; frames: number; struck: boolean; line: number }
export interface ParsedGapRow { kind: 'gap'; frames: number; struck: boolean; line: number }
export interface ParsedSilenceRow {
  kind: 'silence';
  originalMs: number;
  targetMs?: number;
  struck: boolean;
  line: number;
}
export type ParsedRow = ParsedSegRow | ParsedClipRow | ParsedGapRow | ParsedSilenceRow;

export interface ParsedRegion { source: string; rows: ParsedRow[] }
export interface ParsedTrack { track: string; regions: ParsedRegion[] }
export interface ParsedScript {
  stamp: string | null;
  trackId: string | null;
  showSilence: boolean;
  tracks: ParsedTrack[];
}

const err = (line: number, msg: string): never => {
  throw new Error(`timeline.md 第 ${line} 行: ${msg}`);
};

/** split a row body into kept/struck runs by ~~...~~ markers */
export function splitRuns(body: string, line: number): ParsedRun[] {
  const runs: ParsedRun[] = [];
  let rest = body;
  while (rest.length) {
    const open = rest.indexOf('~~');
    if (open === -1) {
      runs.push({ text: rest, struck: false });
      break;
    }
    if (open > 0) runs.push({ text: rest.slice(0, open), struck: false });
    const close = rest.indexOf('~~', open + 2);
    if (close === -1) err(line, '未闭合的 ~~ 删除标记');
    runs.push({ text: rest.slice(open + 2, close), struck: true });
    rest = rest.slice(close + 2);
  }
  return runs.filter((r) => r.text.trim().length > 0).map((r) => ({ ...r, text: r.text.trim() }));
}

export function parseScript(md: string): ParsedScript {
  const tracks: ParsedTrack[] = [];
  let stamp: string | null = null;
  let trackId: string | null = null;
  let showSilence = false;
  let curTrack: ParsedTrack | null = null;
  let curRegion: ParsedRegion | null = null;

  md.split('\n').forEach((raw, idx) => {
    const line = idx + 1;
    let s = raw.trim();
    if (!s || s.startsWith('# ')) return; // blank / H1 title
    const cm = s.match(/^<!--\s*(.*?)\s*-->$/);
    if (cm) {
      const m = cm[1].match(/script-stamp:([a-z0-9]+)/);
      if (m) stamp = m[1];
      const track = cm[1].match(/script-track:(\S+)/);
      if (track) trackId = track[1];
      if (/script-silence:true/.test(cm[1])) showSilence = true;
      return;
    }
    if (s.startsWith('@')) return; // speaker boundary — render-only
    const h2 = s.match(/^##\s+(\S+)$/);
    if (h2) {
      curTrack = { track: h2[1], regions: [] };
      tracks.push(curTrack);
      curRegion = null;
      return;
    }
    const h3 = s.match(/^###\s+(.+)$/);
    if (h3) {
      if (!curTrack) err(line, '### 出现在任何 ## 轨道之前');
      curRegion = { source: h3[1].trim(), rows: [] };
      curTrack!.regions.push(curRegion);
      return;
    }
    // whole-row strike?
    let struck = false;
    const whole = s.match(/^~~(.*)~~$/);
    if (whole && !whole[1].includes('~~')) {
      struck = true;
      s = whole[1].trim();
    }
    const seg = s.match(/^\[s(\d+)(?:@(\d+))?\]\s*(.*)$/);
    const clip = s.match(/^\[c(\d+)\]\s*(\d+)f$/);
    const gap = s.match(/^\[gap\s+(\d+)f\]$/);
    const silence = s.match(/^\[silence=(\d+(?:\.\d+)?)s(?:\s*(?:→|->)\s*(\d+(?:\.\d+)?)s)?\]$/);
    if (!seg && !clip && !gap && !silence) err(line, `无法识别的行: "${raw.trim().slice(0, 40)}"`);
    if (!curRegion) err(line, '内容行出现在任何 ### 素材区之前');
    if (seg) {
      curRegion!.rows.push({
        kind: 'seg', sn: Number(seg[1]),
        occurrence: seg[2] ? Number(seg[2]) : undefined,
        struck, runs: struck ? [] : splitRuns(seg[3], line), line,
      });
    } else if (clip) {
      curRegion!.rows.push({ kind: 'clip', cn: Number(clip[1]), frames: Number(clip[2]), struck, line });
    } else if (gap) {
      curRegion!.rows.push({ kind: 'gap', frames: Number(gap[1]), struck, line });
    } else if (silence) {
      curRegion!.rows.push({
        kind: 'silence',
        originalMs: Math.round(Number(silence[1]) * 1000),
        targetMs: silence[2] === undefined ? undefined : Math.round(Number(silence[2]) * 1000),
        struck,
        line,
      });
    }
  });
  return { stamp, trackId, showSilence, tracks };
}
