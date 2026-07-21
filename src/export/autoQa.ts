import type { ExportQaExpectations, ExportQaReport } from './quality';

const STORAGE_KEY = 'cc.exportAutoQa.v1';
export const MAX_EXPORT_QA_ATTEMPTS = 3;

export interface ExportAutoQaPreference {
  enabled: boolean;
}

export const DEFAULT_EXPORT_AUTO_QA: ExportAutoQaPreference = { enabled: true };

export interface ExportQaRequest extends ExportQaExpectations {
  src: string;
  cutTimesSeconds: number[];
  maxEvidenceCuts: number;
}

export interface ExportQaResponse {
  ok?: boolean;
  error?: string;
  src?: string;
  report?: ExportQaReport;
  evidence?: {
    mediaType?: string;
    base64?: string;
    samples?: { cutSeconds: number; sampleSeconds: number; side: 'before' | 'after' }[];
  };
}

export interface ExportQaRun {
  response: ExportQaResponse & { report: ExportQaReport };
  attempts: number;
}

export function loadExportAutoQaPreference(): ExportAutoQaPreference {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? 'null') as Partial<ExportAutoQaPreference> | null;
    return { enabled: parsed?.enabled !== false };
  } catch {
    return { ...DEFAULT_EXPORT_AUTO_QA };
  }
}

export function saveExportAutoQaPreference(preference: ExportAutoQaPreference): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ enabled: preference.enabled }));
  } catch {
    // Export still works when storage is unavailable or full.
  }
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

class ExportQaHttpError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

export interface RunExportQaOptions {
  fetcher?: typeof fetch;
  maxAttempts?: number;
  retryDelayMs?: number;
}

/** Run export QA with bounded retries for transient server/transport failures. */
export async function runExportQa(
  request: ExportQaRequest,
  options: RunExportQaOptions = {},
): Promise<ExportQaRun> {
  const fetcher = options.fetcher ?? fetch;
  const maxAttempts = Math.max(1, Math.min(
    MAX_EXPORT_QA_ATTEMPTS,
    Math.round(options.maxAttempts ?? MAX_EXPORT_QA_ATTEMPTS),
  ));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 250);
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetcher('/api/export-qa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const result = (await response.json().catch(() => null)) as ExportQaResponse | null;
      if (response.ok && result?.report) return { response: { ...result, report: result.report }, attempts: attempt };
      throw new ExportQaHttpError(
        result?.error ?? `export QA failed (${response.status})`,
        retryableStatus(response.status) || (response.ok && !result?.report),
      );
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      lastError = error;
      const canRetry = !(error instanceof ExportQaHttpError) || error.retryable;
      if (!canRetry || attempt >= maxAttempts) throw error;
      if (retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
  }
  throw lastError ?? new Error('export QA failed');
}
