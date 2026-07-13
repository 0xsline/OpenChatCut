import { activeTranslation, paginate } from '../captions/types';
import { resolveCaptionWords } from '../captions/resolve';
import type { TimelineState } from '../editor/types';

export interface SubmitSubtitleExportArgs {
  subtitleFormat?: 'srt' | 'txt';
  name?: string;
  startFrame?: number;
  endFrameExclusive?: number;
  startSeconds?: number;
  endSeconds?: number;
}

interface SubtitleResponse {
  status?: string;
  path?: string;
  downloadUrl?: string;
  name?: string;
  format?: string;
  cueCount?: number;
  error?: string;
}

function readableText(words: Array<{ text: string }>): string {
  return words.map((word) => word.text).join(' ').replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1');
}

export async function submitSubtitleExport(args: SubmitSubtitleExportArgs, state: TimelineState): Promise<SubtitleResponse> {
  if (!state.captions) throw new Error('the timeline has no captions to export');
  const words = resolveCaptionWords(state.captions, state.items, state.fps);
  const pages = paginate(words, state.captions.pacing);
  const startMs = typeof args.startFrame === 'number' ? args.startFrame / state.fps * 1_000 : (args.startSeconds ?? 0) * 1_000;
  const endMs = typeof args.endFrameExclusive === 'number' ? args.endFrameExclusive / state.fps * 1_000 : typeof args.endSeconds === 'number' ? args.endSeconds * 1_000 : Number.POSITIVE_INFINITY;
  if (startMs < 0 || endMs <= startMs) throw new Error('invalid subtitle export range');
  const cues = pages.flatMap((page) => {
    const start = Math.max(page.start, startMs);
    const end = Math.min(page.end, endMs);
    if (end <= start) return [];
    let text = readableText(page.words);
    if (state.captions?.bilingual && state.captions.translation) {
      const translated = activeTranslation(state.captions.translation, (start + end) / 2);
      if (translated?.text) text += `\n${translated.text}`;
    }
    return [{ start: start - startMs, end: end - startMs, text }];
  });
  const response = await fetch('/generate/subtitles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: args.subtitleFormat ?? 'srt', name: args.name, cues }),
  });
  const result = await response.json().catch(() => ({})) as SubtitleResponse;
  if (!response.ok) throw new Error(result.error ?? `subtitle export failed (${response.status})`);
  if (!result.downloadUrl) throw new Error('subtitle export returned no download URL');
  const anchor = document.createElement('a');
  anchor.href = result.downloadUrl;
  anchor.download = result.name ?? `subtitles.${args.subtitleFormat ?? 'srt'}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  return result;
}
