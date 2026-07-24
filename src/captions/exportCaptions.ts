// Subtitle export (submit_export format=subtitles, subtitleFormat srt/txt):
// Paging into cues from the current subtitle track (CaptionsData → resolveCaptionWords rearranged word list),
// Spit SubRip or plain text. Pure function, no DOM/fetch, same input and same output, shared by check and UI.
import { paginate, type CaptionPage } from './types';
import { resolveCaptionWords } from './resolve';
import type { CaptionsData } from './types';
import type { TimelineItem } from '../editor/types';
import { isManualCaptionEntry } from './manualCaptions';

/** ms → SRT time code `HH:MM:SS,mmm`。 */
export function srtTimestamp(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const hh = Math.floor(clamped / 3_600_000);
  const mm = Math.floor((clamped % 3_600_000) / 60_000);
  const ss = Math.floor((clamped % 60_000) / 1000);
  const mmm = clamped % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)},${pad(mmm, 3)}`;
}

/** Direct concatenation of adjacent words in Chinese,Contains Spanish spaces between words(with CaptionsLayer Render consistent spelling rules)。 */
function pageText(page: CaptionPage): string {
  let out = '';
  for (const word of page.words) {
    const text = word.text.trim();
    if (!text) continue;
    if (out && !/[one-Yi　-〿]$/.test(out) && !/^[one-Yi　-〿]/.test(text)) out += ' ';
    else if (out && (/[A-Za-z0-9]$/.test(out) || /^[A-Za-z0-9]/.test(text))) out += ' ';
    out += text;
  }
  return out;
}

/** subtitles cue list(SRT with TXT common intermediate state of). Empty vocabulary → []。 */
export function captionPages(captions: CaptionsData, items: TimelineItem[], fps: number): CaptionPage[] {
  if (captions.sourceEntries?.some(isManualCaptionEntry)) {
    const manual = captions.sourceEntries
      .filter((entry) => isManualCaptionEntry(entry) && entry.visible !== false)
      .flatMap((entry) => entry.words ?? [])
      .map((word) => ({ words: [word], start: word.start, end: word.end }));
    const automaticEntries = captions.sourceEntries.filter((entry) => !isManualCaptionEntry(entry));
    const automaticWords = automaticEntries.length
      ? resolveCaptionWords({ ...captions, sourceEntries: automaticEntries }, items, fps)
      : [];
    return [...paginate(automaticWords, captions.pacing ?? 'phrase'), ...manual]
      .sort((a, b) => a.start - b.start || a.end - b.end);
  }
  const words = resolveCaptionWords(captions, items, fps);
  if (!words.length) return [];
  return paginate(words, captions.pacing ?? 'phrase');
}

/** SubRip (.srt):serial number + Start and end time code + Single line of text. */
export function captionsToSrt(captions: CaptionsData, items: TimelineItem[], fps: number): string {
  const pages = captionPages(captions, items, fps);
  return pages
    .map((page, index) => `${index + 1}\n${srtTimestamp(page.start)} --> ${srtTimestamp(page.end)}\n${pageText(page)}`)
    .join('\n\n') + (pages.length ? '\n' : '');
}

/** plain text (.txt):One page per line,No timecode. */
export function captionsToTxt(captions: CaptionsData, items: TimelineItem[], fps: number): string {
  const pages = captionPages(captions, items, fps);
  return pages.map(pageText).join('\n') + (pages.length ? '\n' : '');
}
