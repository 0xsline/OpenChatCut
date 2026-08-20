import type { AgentContext } from '../context';
import type { AgentToolSchema } from '../tool-schema';
import type { TimelineItem } from '../../editor/types';

type Args = Record<string, unknown>;

export const JIANYING_EXPORT_TOOL_NAME = 'export_jianying_draft';

export const jianyingExportToolSchema: AgentToolSchema = {
  name: JIANYING_EXPORT_TOOL_NAME,
  description: 'Export the current timeline as a CapCut/JianYing draft (via capcut-cli). The draft appears in the CapCut/JianYing project list; open it there to review and render. Only call this when the user explicitly confirms the export.',
  input_schema: {
    type: 'object',
    properties: {
      draftName: { type: 'string', description: 'Draft name shown in CapCut/JianYing. Defaults to a timestamped name.' },
      draftsDir: { type: 'string', description: 'Optional draft store directory override (defaults to the CapCut store).' },
    },
    additionalProperties: false,
  },
};

export function mediaItems(items: TimelineItem[]): TimelineItem[] {
  return items.filter((item) => item.kind === 'video' || item.kind === 'image' || item.kind === 'gif' || item.kind === 'audio');
}

/** Caption cues from the active captions overlay: merge transcript words into
 * phrase cues (timeline ms). Falls back to the source item's transcript. */
export function captionCues(state: { fps: number; items: TimelineItem[] }, captions: { enabled?: boolean; sourceItemId?: string | null; sourceMode?: 'item' | 'timeline'; sources?: string[] } | null | undefined): { startMs: number; endMs: number; text: string }[] {
  if (!captions?.enabled) return [];
  const cueWords = (item: TimelineItem | undefined): { start: number; end: number; text: string }[] | undefined => {
    if (!item?.transcript || item.transcript.length === 0) return undefined;
    return item.transcript;
  };
  let words: { start: number; end: number; text: string }[] = [];
  if (captions.sourceMode === 'timeline') {
    for (const item of state.items) {
      const candidate = cueWords(item);
      if (candidate) words = [...words, ...candidate];
    }
  } else if (captions.sourceItemId) {
    words = cueWords(state.items.find((item) => item.id === captions.sourceItemId)) ?? [];
  }
  if (words.length === 0) return [];
  words = [...words].sort((a, b) => a.start - b.start);
  const cues: { startMs: number; endMs: number; text: string }[] = [];
  let current: { startMs: number; endMs: number; text: string } | null = null;
  for (const word of words) {
    if (!word.text.trim()) continue;
    if (!current) {
      current = { startMs: word.start, endMs: word.end, text: word.text.trim() };
      continue;
    }
    const gap = word.start - current.endMs;
    if (gap <= 450) {
      current.endMs = Math.max(current.endMs, word.end);
      current.text = `${current.text} ${word.text.trim()}`;
    } else {
      cues.push(current);
      current = { startMs: word.start, endMs: word.end, text: word.text.trim() };
    }
  }
  if (current) cues.push(current);
  return cues;
}

export async function execJianyingExport(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== JIANYING_EXPORT_TOOL_NAME) return undefined;
  const state = ctx.getState();
  const items = mediaItems(state.items);
  const body: Record<string, unknown> = {
    draftName: typeof args.draftName === 'string' && args.draftName.trim() ? String(args.draftName).trim().slice(0, 60) : '',
    draftsDir: typeof args.draftsDir === 'string' && args.draftsDir.trim() ? String(args.draftsDir).trim() : '',
    fps: state.fps,
    items: items.map((item) => ({
      kind: item.kind,
      src: item.src ?? '',
      startFrame: item.startFrame,
      durationInFrames: item.durationInFrames,
      volume: item.volume,
      name: item.name,
    })),
    captions: captionCues(state, state.captions),
  };
  const response = await fetch('/api/external-agent/jianying-export', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as {
    ok?: boolean; error?: string; draftName?: string; draftPath?: string;
    addedVideos?: number; addedAudios?: number; captions?: number; warnings?: string[];
  } | null;
  if (!response.ok || !data?.ok) {
    throw new Error(data?.error ?? `jianying export failed (${response.status})`);
  }
  return {
    ok: true,
    draftName: data.draftName,
    draftPath: data.draftPath,
    addedVideos: data.addedVideos,
    addedAudios: data.addedAudios,
    captions: data.captions,
    warnings: data.warnings ?? [],
    note: 'Draft written to the CapCut/JianYing store. Restart CapCut/JianYing if the project list does not refresh.',
  };
}