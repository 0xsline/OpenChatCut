// Caption export (submit_export format=captions, subtitleFormat srt/txt):
// Page into cue from the current caption track (CaptionsData → resolveCaptionWords rearranged word list),
// Spit SubRip or plain text. Pure function, no DOM/fetch, same input and same output, shared by check and UI.
import { joinCaptionWords, type CaptionPage, type CaptionsData } from './types';
import type { TimelineItem } from '../editor/types';
import { buildCaptionPages } from './captionPages';

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
  return joinCaptionWords(page.words);
}

/** caption cue list (common intermediate state between SRT and TXT). Empty vocabulary → [].*/
export function captionPages(captions: CaptionsData, items: TimelineItem[], fps: number): CaptionPage[] {
  return buildCaptionPages(captions, items, fps).map((identity) => identity.page);
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
