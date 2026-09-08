// The interface language, as the server knows it.
//
// Server-authored text that reaches the user — the remedy on a failed import, a note
// pushed into a run — used to be written in one fixed language, because the server has
// no navigator and no localStorage. The browser now mirrors its locale switch into the
// non-secret UI_LOCALE setting (src/i18n/localeSync.ts), so every server message can ask
// here instead of guessing. Unset means the app's original Chinese.
import { getKey } from './keystore.ts';

export type UiLocale = 'zh' | 'en' | 'it' | 'ru';

const LOCALES: ReadonlySet<string> = new Set(['zh', 'en', 'it', 'ru']);

export function parseUiLocale(value: unknown): UiLocale | null {
  const tag = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return LOCALES.has(tag) ? (tag as UiLocale) : null;
}

export function uiLocale(): UiLocale {
  return parseUiLocale(getKey('UI_LOCALE')) ?? 'zh';
}

/** Pick the variant for the current interface language; Italian falls back to English when not provided. */
export function localized<T>(variants: { zh: T; en: T; ru?: T; it?: T }, locale: UiLocale = uiLocale()): T {
  if (locale === 'zh') return variants.zh;
  if (locale === 'ru') return variants.ru ?? variants.en;
  if (locale === 'it') return variants.it ?? variants.en;
  return variants.en;
}
