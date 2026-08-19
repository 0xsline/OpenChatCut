import type { CapabilityKey } from '../../agent/capabilities';
import { currentCaps } from '../../agent/capabilities';

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

export function missingCreativeCaps(): readonly CapabilityKey[] {
  const caps = currentCaps();
  return BANNER_CAPS.filter((key) => caps[key] !== true);
}
