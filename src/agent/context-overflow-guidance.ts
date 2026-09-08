import { t } from '../i18n/locale';

const FIRST_MESSAGE_OVERFLOW = 'The current request is too large for this model context window.';
const POST_COMPACTION_OVERFLOW = 'The recent conversation is still too large after context compaction.';

export const CONTEXT_OVERFLOW_GUIDANCE_ZH =
  '当前请求的上下文超出了模型限制，系统已自动压缩并重试但仍放不下。换个更短的问法或新开一个聊天继续即可。';

const GUIDANCE_SEPARATOR = '\n\n';

function isOverflowMessage(message: string): boolean {
  return message.includes(FIRST_MESSAGE_OVERFLOW) || message.includes(POST_COMPACTION_OVERFLOW);
}

export function contextOverflowGuidance(message: string): string | null {
  if (!isOverflowMessage(message)) return null;
  return `${t(CONTEXT_OVERFLOW_GUIDANCE_ZH)}${GUIDANCE_SEPARATOR}${message}`;
}

export function extractOverflowOriginal(text: string): string | null {
  // Try both spellings: the current locale and the Chinese original the
  // dictionary falls back to. Messages are composed once at bind time, so a
  // locale switch between compose and extract stays recoverable either way.
  for (const prefix of [t(CONTEXT_OVERFLOW_GUIDANCE_ZH), CONTEXT_OVERFLOW_GUIDANCE_ZH]) {
    const full = `${prefix}${GUIDANCE_SEPARATOR}`;
    if (text.startsWith(full)) return text.slice(full.length);
  }
  return null;
}
