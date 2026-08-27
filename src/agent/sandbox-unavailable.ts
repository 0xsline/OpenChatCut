import { currentCaps } from './capabilities';

export const SANDBOX_SKIP_NOTE =
  'Sandbox is not configured (no E2B_API_KEY). Do not retry run_code or probe_media. '
  + 'Flex crop uses edit_item transform.crop in composition pixels. Prior editor edits still stand.';

export function isSandboxNotConfiguredMessage(message: string): boolean {
  return /sandbox is not configured|E2B_API_KEY/i.test(message);
}

export function sandboxSkippedResult(detail?: string): { ok: true; skipped: true; note: string } {
  const extra = detail?.trim();
  return {
    ok: true,
    skipped: true,
    note: extra ? `${extra} ${SANDBOX_SKIP_NOTE}` : SANDBOX_SKIP_NOTE,
  };
}

/** Skip before hitting /e2b/run when the capability is off. */
export function sandboxSkipIfUnconfigured(): { ok: true; skipped: true; note: string } | null {
  return currentCaps().sandbox ? null : sandboxSkippedResult();
}

export function sandboxSkipFromHttpError(message: string): { ok: true; skipped: true; note: string } | null {
  return isSandboxNotConfiguredMessage(message) ? sandboxSkippedResult(message) : null;
}
