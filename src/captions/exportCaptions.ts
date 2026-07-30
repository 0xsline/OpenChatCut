// 字幕导出(submit_export format=subtitles, subtitleFormat srt/txt):
// 从当前字幕轨(CaptionsData → resolveCaptionWords 重排后的词表)分页成 cue,
// 吐 SubRip 或纯文本。纯函数,无 DOM/fetch,同输入同输出,供 check 与 UI 共用。
import { paginate, type CaptionPage } from './types';
import { resolveCaptionWords } from './resolve';
import type { CaptionsData } from './types';
import type { TimelineItem } from '../editor/types';
import { isManualCaptionEntry } from './manualCaptions';

/** ms → SRT 时间码 `HH:MM:SS,mmm`。 */
export function srtTimestamp(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const hh = Math.floor(clamped / 3_600_000);
  const mm = Math.floor((clamped % 3_600_000) / 60_000);
  const ss = Math.floor((clamped % 60_000) / 1000);
  const mmm = clamped % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)},${pad(mmm, 3)}`;
}

/** 中文相邻词直接连写,含西文的词间空格(与 CaptionsLayer 渲染一致的拼行规则)。 */
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

/** 字幕 cue 列表(SRT 与 TXT 的共同中间态)。空词表 → []。 */
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

/** SubRip (.srt):序号 + 起止时间码 + 单行文本。 */
export function captionsToSrt(captions: CaptionsData, items: TimelineItem[], fps: number): string {
  const pages = captionPages(captions, items, fps);
  return pages
    .map((page, index) => `${index + 1}\n${srtTimestamp(page.start)} --> ${srtTimestamp(page.end)}\n${pageText(page)}`)
    .join('\n\n') + (pages.length ? '\n' : '');
}

/** 纯文本 (.txt):一页一行,无时间码。 */
export function captionsToTxt(captions: CaptionsData, items: TimelineItem[], fps: number): string {
  const pages = captionPages(captions, items, fps);
  return pages.map(pageText).join('\n') + (pages.length ? '\n' : '');
}
