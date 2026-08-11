export interface BrowserToolRequest {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly argsDigest: string;
  readonly admit: () => boolean;
}
export interface ToolClaimResponse {
  readonly claimed?: boolean;
  readonly outcome?: string;
}


export function permanentToolHttpStatus(status: number): boolean {
  return status >= 400
    && status < 500
    && status !== 408
    && status !== 425
    && status !== 429;
}

const MAX_RETRY_DELAY_MS = 10_000;

export function scheduleServerRunToolResultRetry(
  post: () => Promise<boolean>,
  settled: () => void,
  active: () => boolean,
  delay = 250,
): void {
  setTimeout(() => {
    if (!active()) return;
    void post().then((done) => {
      if (done) {
        settled();
        return;
      }
      scheduleServerRunToolResultRetry(
        post,
        settled,
        active,
        Math.min(delay * 2, MAX_RETRY_DELAY_MS),
      );
    });
  }, delay);
}
