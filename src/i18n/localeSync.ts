// Mirror the interface language into the server's non-secret UI_LOCALE setting.
//
// The server authors some text the user reads directly — the remedy on a failed media
// import, a note pushed into an agent run — and it has no navigator or localStorage to
// learn the language from. The browser owns that choice, so it tells the server: once at
// startup when the stored value differs, and again on every switch. Fire-and-forget; a
// missing server (static preview, verifies) is not an error.
import { getLocale, subscribeLocale, type Locale } from './locale';

let lastSent: string | null = null;

async function send(locale: Locale): Promise<void> {
  if (lastSent === locale || typeof fetch !== 'function') return;
  lastSent = locale;
  try {
    await fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ UI_LOCALE: locale }),
    });
  } catch {
    lastSent = null;
  }
}

/**
 * Start mirroring. `stored` is the server's current UI_LOCALE (from GET /api/keys → models)
 * so an already-synced value is not re-sent on every launch.
 */
export function startUiLocaleSync(stored?: string): () => void {
  if (stored === getLocale()) lastSent = stored;
  void send(getLocale());
  return subscribeLocale(() => { void send(getLocale()); });
}
