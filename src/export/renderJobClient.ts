import { ExportFailureError, isExportFailure } from './exportFailure';
import type { ExportJobSnapshot } from './exportWorkflowTypes';

export class RenderJobRequestError extends Error {
  readonly status: number;
  readonly responseMessage?: string;

  constructor(status: number, responseMessage?: string) {
    super(responseMessage ?? `render job request failed (${status})`);
    this.name = 'RenderJobRequestError';
    this.status = status;
    this.responseMessage = responseMessage;
  }
}

async function readBody(response: Response): Promise<Record<string, unknown> | null> {
  const body: unknown = await response.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
}

function responseError(response: Response, body: Record<string, unknown> | null): Error {
  if (isExportFailure(body?.failure)) return new ExportFailureError(body.failure);
  return new RenderJobRequestError(response.status, typeof body?.error === 'string' ? body.error : undefined);
}

export async function submitRenderJob(body: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const response = await fetch('/export/job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const submitted = await readBody(response);
  if (isExportFailure(submitted?.failure)) throw new ExportFailureError(submitted.failure);
  const renderId = submitted?.renderId;
  if (!response.ok || typeof renderId !== 'string' || !renderId.trim()
    || (typeof body.operationId === 'string' && renderId !== body.operationId)) {
    throw responseError(response, submitted);
  }
  return renderId;
}

export async function readRenderJobSnapshot(
  renderId: string,
  signal?: AbortSignal,
): Promise<ExportJobSnapshot & { id: string }> {
  const response = await fetch(`/export/job/${encodeURIComponent(renderId)}`, { method: 'GET', signal });
  const snapshot = await readBody(response);
  const validSnapshot = snapshot
    && (snapshot.status === 'queued' || snapshot.status === 'running'
      || snapshot.status === 'succeeded' || snapshot.status === 'failed')
    && typeof snapshot.progress === 'number' && Number.isFinite(snapshot.progress)
    && (snapshot.id === undefined || snapshot.id === renderId);
  if (!response.ok || !validSnapshot) throw responseError(response, snapshot);
  return {
    ...snapshot,
    id: renderId,
    failure: isExportFailure(snapshot.failure) ? snapshot.failure : undefined,
  } as ExportJobSnapshot & { id: string };
}

export async function cancelRenderJob(renderId: string): Promise<void> {
  const response = await fetch(`/export/job/${encodeURIComponent(renderId)}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) throw responseError(response, await readBody(response));
}
