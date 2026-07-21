import type { AutoGradeAnalysis } from './autoGradeCore';

export interface AutoGradeRequest {
  src: string;
  startSeconds?: number;
  durationSeconds?: number;
}

export interface AutoGradeResponse extends AutoGradeAnalysis {
  ok: true;
  src: string;
  analyzedStartSeconds: number;
  analyzedDurationSeconds: number;
}

export async function analyzeAutoGrade(
  request: AutoGradeRequest,
  fetcher: typeof fetch = fetch,
): Promise<AutoGradeResponse> {
  const response = await fetcher('/api/auto-grade', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const body = (await response.json().catch(() => ({}))) as AutoGradeResponse & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `auto grade analysis failed (${response.status})`);
  return body;
}
