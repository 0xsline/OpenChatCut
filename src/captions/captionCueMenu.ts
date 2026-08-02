import type { TranscriptWord } from '../transcript/types';
import type { CaptionsData } from './types';
import { updateManualCue } from './manualCaptions';

export const CAPTION_CUE_TRANSLATION_LANGS = [
  { label: 'English', flag: '🇺🇸' },
  { label: '日本語', flag: '🇯🇵' },
  { label: '한국어', flag: '🇰🇷' },
  { label: 'Español', flag: '🇪🇸' },
  { label: 'Français', flag: '🇫🇷' },
  { label: 'Deutsch', flag: '🇩🇪' },
  { label: 'Português', flag: '🇵🇹' },
] as const;

export interface CaptionCueTextTarget {
  laneId: string;
  index: number;
  words: readonly TranscriptWord[];
}

export function captionCueText(target: CaptionCueTextTarget): string {
  return target.words[target.index]?.text.trim() ?? '';
}

export function replaceCaptionCueText(
  captions: CaptionsData,
  target: CaptionCueTextTarget,
  text: string,
): Partial<CaptionsData> | null {
  const cue = target.words[target.index];
  const clean = text.trim();
  if (!cue || !clean) return null;
  return updateManualCue(captions, target.laneId, target.index, clean, cue.start, cue.end);
}

export function captionCueAgentSeed(text: string): string {
  return text.trim();
}
