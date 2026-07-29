// Caption export (submit_export format=captions, subtitleFormat srt/txt):
// Page into cue from the current caption track (CaptionsData → resolveCaptionWords rearranged word list),
// Spit SubRip or plain text. Pure function, no DOM/fetch, same input and same output, shared by check and UI.
import { paginate, type CaptionPage } from './types';
import { resolveCaptionWords } from './resolve';
import type { CaptionsData } from './types';
import type { TimelineItem } from '../editor/types';
import { isManualCaptionEntry } from './manualCaptions';

/** ms → SRT timecode `HH:MM:SS,mmm`. */
export function srtTimestamp(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const hh = Math.floor(clamped / 3_600_000);
  const mm = Math.floor((clamped % 3_600_000) / 60_000);
  const ss = Math.floor((clamped % 60_000) / 1000);
  const mmm = clamped % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)},${pad(mmm, 3)}`;
}

/** Chinese adjacent words are directly connected, including spaces between Western words (same spelling rules as CaptionsLayer rendering).*/
function pageText(page: CaptionPage): string {
  let out = '';
  for (const word of page.words) {
    const text = word.text.trim();
    if (!text) continue;
    if (out && !/[一-鿿　-〿]$/.test(out) && !/^[一-鿿　-〿]/.test(text)) out += ' ';
    else if (out && (/[A-Za-z0-9]$/.test(out) || /^[A-Za-z0-9]/.test(text))) out += ' ';
    out += text;
  }
  return out;
}

/** caption cue list (common intermediate state between SRT and TXT). Empty vocabulary → [].*/
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

/** SubRip (.srt): sequence number + start and end time codes + single line text.*/
export function captionsToSrt(captions: CaptionsData, items: TimelineItem[], fps: number): string {
  const pages = captionPages(captions, items, fps);
  return pages
    .map((page, index) => `${index + 1}\n${srtTimestamp(page.start)} --> ${srtTimestamp(page.end)}\n${pageText(page)}`)
    .join('\n\n') + (pages.length ? '\n' : '');
}

/** Plain text (.txt): one line per page, no timecode.*/
export function captionsToTxt(captions: CaptionsData, items: TimelineItem[], fps: number): string {
  const pages = captionPages(captions, items, fps);
  return pages.map(pageText).join('\n') + (pages.length ? '\n' : '');
}
