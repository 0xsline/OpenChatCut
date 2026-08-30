// The four locale dictionaries are ~560 kB of source. Importing them statically
// put all four in the entry chunk, so every user downloaded and parsed three
// languages they cannot read before the first frame. Each locale is fetched on
// demand instead.
//
// t()/tData() stay SYNCHRONOUS: they read whatever is loaded and fall back to
// the Chinese original, which is also the dictionary key — the same "never go
// blank" contract locale.ts always had. main.tsx awaits the active locale's
// dictionary before the first render, so no rendered frame sees the fallback.
import type { Locale } from './locale';

export interface LocaleDicts {
  /** UI copy for the active locale. */
  readonly ui: Record<string, string>;
  /** UI copy consulted when `ui` has no entry (Italian falls back to English). */
  readonly uiFallback: Record<string, string>;
  /** Display names for **data** (template/sound/music names). */
  readonly data: Record<string, string>;
  /** Data names consulted when `data` has no entry. */
  readonly dataFallback: Record<string, string>;
}

const EMPTY: Record<string, string> = Object.freeze({});

/** Nothing loaded: every lookup falls through to the Chinese original. */
const NONE: LocaleDicts = Object.freeze({
  ui: EMPTY, uiFallback: EMPTY, data: EMPTY, dataFallback: EMPTY,
});

// Replaced, never mutated, so a lookup mid-load sees one consistent snapshot.
let loaded: Readonly<Partial<Record<Locale, LocaleDicts>>> = {};
const inFlight = new Map<Locale, Promise<void>>();

async function fetchDicts(locale: Locale): Promise<LocaleDicts> {
  if (locale === 'zh') {
    // Chinese IS the key language, so only the data names need a table.
    const { ZH_DATA } = await import('./dict/zh');
    return { ui: EMPTY, uiFallback: EMPTY, data: ZH_DATA, dataFallback: EMPTY };
  }
  if (locale === 'en') {
    const [en, enData] = await Promise.all([
      import('./dict/en'), import('./dict/en/templates-data'),
    ]);
    return { ui: en.EN, uiFallback: EMPTY, data: enData.default, dataFallback: EMPTY };
  }
  if (locale === 'ru') {
    // Russian UI has no English fallback (untranslated keys stay Chinese), but
    // its data names come from the English table, matching tData() before.
    const [ru, enData] = await Promise.all([
      import('./dict/ru'), import('./dict/en/templates-data'),
    ]);
    return { ui: ru.RU, uiFallback: EMPTY, data: enData.default, dataFallback: EMPTY };
  }
  const [it, itData, en, enData] = await Promise.all([
    import('./dict/it'), import('./dict/it/templates-data'),
    import('./dict/en'), import('./dict/en/templates-data'),
  ]);
  return { ui: it.IT, uiFallback: en.EN, data: itData.default, dataFallback: enData.default };
}

/** The dictionaries currently in memory for `locale` (empty until loaded). */
export function localeDicts(locale: Locale): LocaleDicts {
  return loaded[locale] ?? NONE;
}

/** True once `locale`'s dictionaries are in memory and lookups are complete. */
export function localeDictReady(locale: Locale): boolean {
  return loaded[locale] !== undefined;
}

/** Load `locale`'s dictionaries once; concurrent callers share the same fetch. */
export function ensureLocaleDict(locale: Locale): Promise<void> {
  const pending = inFlight.get(locale);
  if (pending) return pending;
  const task = fetchDicts(locale)
    .then((dicts) => { loaded = { ...loaded, [locale]: dicts }; })
    .catch(() => {
      // A failed chunk fetch (offline, stale deploy) must not blank the UI —
      // t() keeps returning the Chinese original. Drop the memo so switching
      // back to this locale retries instead of being stuck on the failure.
      inFlight.delete(locale);
    });
  inFlight.set(locale, task);
  return task;
}
