import type { CapabilityKey } from '../../agent/capabilities';
import { currentCaps } from '../../agent/capabilities';
import type { Locale } from '../../i18n/locale';
import {
  anyLocalAsrReady,
  type LocalAsrModelStatus,
} from '../../transcript/local-asr-readiness';

/**
 * Capabilities whose absence blocks common creative tasks (captions,
 * generation). Search/sandbox/web gaps stay silent: they do not block the
 * user-facing workflow this banner exists to unblock.
 */
const BANNER_CAPS: readonly CapabilityKey[] = ['transcription', 'image', 'voice', 'video', 'music', 'sound'];

/** Chinese source text doubles as the i18n key; the en dictionary maps it. */
export const CAPABILITY_LABELS: Partial<Record<CapabilityKey, string>> = {
  transcription: '转写',
  image: '图片生成',
  voice: '语音合成',
  video: '视频生成',
  music: '音乐生成',
  sound: '音效生成',
};

/**
 * Why transcription can or cannot run. Local Whisper is free and needs no key,
 * so it must never be reported as "not configured" just because no cloud
 * provider is set: `missing` means the offline engine is offered but its model
 * is not downloaded yet, which the banner phrases as a free next step.
 */
export type TranscriptionAvailability = 'ready' | 'missing' | 'unknown';

/** Read the local ASR catalog (GET /api/asr-models) into a banner state. */
export function transcriptionAvailability(
  catalog: readonly LocalAsrModelStatus[] | null,
): TranscriptionAvailability {
  if (catalog === null) return 'unknown'; // Unreadable catalog: keep the old honest "unknown" wording.
  return anyLocalAsrReady(catalog) ? 'ready' : 'missing';
}

export function missingCreativeCaps(
  caps: Record<CapabilityKey, boolean> = currentCaps(),
  transcription: TranscriptionAvailability = 'unknown',
): readonly CapabilityKey[] {
  return BANNER_CAPS.filter((key) => {
    // `missing` is surfaced separately as a free download prompt, `ready` is available.
    if (key === 'transcription') return transcription === 'unknown';
    return caps[key] !== true;
  });
}

export function formatCapabilityNames(names: readonly string[], locale: Locale): string {
  return locale === 'zh'
    ? names.join('、')
    : new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(names);
}
