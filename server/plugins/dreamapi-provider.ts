import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { getKey } from '../keystore.ts';
import { resolveUploadFile } from '../media-dir.ts';
import { buildDreamApiCall, type DreamApiCall, type DreamApiModel } from '../../shared/dreamapi-models.ts';

export const DREAMAPI_BASE_URL = 'https://api.newportai.com';

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface DreamApiRunOptions {
  apiKey: string;
  fetchImpl?: FetchImpl;
  existingTaskId?: string;
  registerTask?: (taskId: string) => Promise<void>;
  pollIntervalMs?: number;
}

export interface DreamApiRunResult {
  taskId: string;
  urls: string[];
  cloneId?: string;
}

function apiKey(): string {
  const key = getKey('DREAMAPI_API_KEY').trim();
  if (!key) throw new Error('DreamAPI is not configured. Set DREAMAPI_API_KEY in Settings. The key stays on this machine.');
  return key;
}

function isHttp(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

async function localFile(value: string): Promise<{ path: string; name: string } | undefined> {
  if (isHttp(value)) return undefined;
  if (value.startsWith('/media/uploads/')) {
    const name = basename(value);
    const path = resolveUploadFile(name);
    if (!path) throw new Error(`DreamAPI media file not found: ${value}`);
    return { path, name };
  }
  if (value.startsWith('/')) return { path: value, name: basename(value) };
  return undefined;
}

async function dreamApiJson(fetchImpl: FetchImpl, key: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetchImpl(`${DREAMAPI_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as { code?: number; message?: string; data?: Record<string, unknown> };
  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.message || `DreamAPI request failed (${response.status})`);
  }
  return payload.data ?? {};
}

async function uploadLocal(fetchImpl: FetchImpl, key: string, filePath: string, fileName: string): Promise<string> {
  const policy = await dreamApiJson(fetchImpl, key, '/api/file/v1/get_policy', { scene: 'Dream-CN' });
  const host = String(policy.host ?? '');
  const accessId = String(policy.accessId ?? policy.OSSAccessKeyId ?? '');
  const policyText = String(policy.policy ?? '');
  const signature = String(policy.signature ?? '');
  const fullKey = String(policy.key ?? '');
  const uploadDir = String(policy.dir ?? '');
  const objectKey = fullKey || (uploadDir ? `${uploadDir}${fileName}` : '');
  if (!host || !objectKey || !accessId || !policyText || !signature) throw new Error('DreamAPI upload policy is incomplete');
  const bytes = await readFile(filePath);
  const form = new FormData();
  form.set('key', objectKey);
  form.set('policy', policyText);
  form.set('OSSAccessKeyId', accessId);
  form.set('signature', signature);
  form.set('callback', String(policy.callback ?? ''));
  form.set('success_action_status', '200');
  form.set('file', new Blob([bytes]), fileName);
  const uploaded = await fetchImpl(host, { method: 'POST', body: form });
  if (!uploaded.ok) throw new Error(`DreamAPI upload failed (${uploaded.status})`);
  const uploadedJson = await uploaded.json() as { data?: { reqId?: string } };
  const reqId = uploadedJson.data?.reqId || String(policy.reqId ?? '');
  if (!reqId) throw new Error('DreamAPI upload did not return reqId');
  const finished = await dreamApiJson(fetchImpl, key, '/api/file/v1/policy_upload_finish', { reqId });
  const url = String(finished.url ?? '');
  if (!url) throw new Error('DreamAPI upload did not return a URL');
  return url;
}

async function resolveMediaValue(fetchImpl: FetchImpl, key: string, value: string): Promise<string> {
  const file = await localFile(value);
  if (!file) return value;
  return uploadLocal(fetchImpl, key, file.path, file.name || `upload${extname(file.path)}`);
}

export async function prepareDreamApiCall(modelId: string | undefined, input: Record<string, unknown>, key: string, fetchImpl: FetchImpl): Promise<DreamApiCall> {
  const draft = buildDreamApiCall(modelId, input);
  const resolved: Record<string, unknown> = { ...input };
  for (const field of draft.model.fields) {
    const value = input[field.key];
    if (field.kind === 'media' && typeof value === 'string') {
      resolved[field.key] = await resolveMediaValue(fetchImpl, key, value);
    }
    if (field.kind === 'mediaList' && Array.isArray(value)) {
      const urls: string[] = [];
      for (const item of value) {
        if (typeof item !== 'string') continue;
        urls.push(await resolveMediaValue(fetchImpl, key, item));
      }
      resolved[field.key] = urls;
    }
  }
  return buildDreamApiCall(modelId, resolved);
}

function collectUrls(data: Record<string, unknown>): { urls: string[]; cloneId?: string } {
  const urls: string[] = [];
  const push = (value: unknown, key: string) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (item && typeof item === 'object' && typeof (item as Record<string, unknown>)[key] === 'string') {
        urls.push((item as Record<string, string>)[key]);
      }
    }
  };
  push(data.images, 'imageUrl');
  push(data.videos, 'videoUrl');
  push(data.audios, 'audioUrl');
  const matting = data.mattingResult;
  if (matting && typeof matting === 'object') {
    const record = matting as Record<string, unknown>;
    for (const key of ['mattingFileUrl', 'mattingAlphaFileUrl', 'compositeFileUrl']) {
      if (typeof record[key] === 'string') urls.push(record[key]);
    }
  }
  const cloneId = typeof data.cloneId === 'string' ? data.cloneId : undefined;
  return { urls: [...new Set(urls)], cloneId };
}

export async function runDreamApi(call: DreamApiCall, options: DreamApiRunOptions): Promise<DreamApiRunResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const key = options.apiKey;
  let taskId = options.existingTaskId?.startsWith('dreamapi:') ? options.existingTaskId.slice('dreamapi:'.length) : '';
  if (!taskId) {
    const submitted = await dreamApiJson(fetchImpl, key, call.model.endpoint, call.body);
    taskId = String(submitted.taskId ?? '');
    if (!taskId) throw new Error('DreamAPI did not return a taskId');
    if (options.registerTask) await options.registerTask(`dreamapi:${taskId}`);
  }
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const data = await dreamApiJson(fetchImpl, key, '/api/getAsyncResult', { taskId });
    const task = data.task as { status?: number; reason?: string } | undefined;
    const status = task?.status;
    if (status === 3) {
      const found = collectUrls(data);
      if (!found.urls.length && !found.cloneId) throw new Error('DreamAPI succeeded without a media URL');
      return { taskId, ...found };
    }
    if (status === 4) throw new Error(task?.reason || 'DreamAPI generation failed');
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 3_000));
  }
  throw new Error('DreamAPI generation timed out');
}

export async function generateDreamApi(modelId: string | undefined, input: Record<string, unknown>, options: Omit<DreamApiRunOptions, 'apiKey'> & { apiKey?: string }): Promise<DreamApiRunResult> {
  const key = options.apiKey ?? apiKey();
  const fetchImpl = options.fetchImpl ?? fetch;
  if (options.existingTaskId?.startsWith('dreamapi:')) {
    const model = buildDreamApiCall(modelId, input).model;
    return runDreamApi({ model, body: {} }, { ...options, apiKey: key, fetchImpl });
  }
  const call = await prepareDreamApiCall(modelId, input, key, fetchImpl);
  return runDreamApi(call, { ...options, apiKey: key, fetchImpl });
}

export function dreamApiMediaInput(model: DreamApiModel, input: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const field of model.fields) {
    if (input[field.key] !== undefined) next[field.key] = input[field.key];
  }
  return next;
}
