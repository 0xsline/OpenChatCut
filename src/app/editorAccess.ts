// Browsers expose crypto.randomUUID, crypto.subtle, WebCodecs and the async clipboard
// only to secure contexts: https: pages and loopback http: (localhost, 127.0.0.1, [::1]).
// The editor relies on all of them, so over plain HTTP from another machine it cannot
// work, and a UUID fallback would only move the crash (#183). The browser's own
// isSecureContext verdict decides; the origin is carried along for the explanation.
export type EditorAccess =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'insecure-context'; readonly origin: string };

export function editorAccess(isSecureContext: boolean, origin: string): EditorAccess {
  return isSecureContext ? { kind: 'allowed' } : { kind: 'insecure-context', origin };
}
