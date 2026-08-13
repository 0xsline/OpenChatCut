import assert from 'node:assert/strict';
import { request } from 'node:http';
import { EDITOR_TOKEN_HEADER, editorApiToken } from '../editor-auth.ts';

interface HttpResult {
  status: number;
  body: string;
}

export function editorFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const url = new URL(input);
  headers.set('Origin', url.origin);
  headers.set(EDITOR_TOKEN_HEADER, editorApiToken());
  return globalThis.fetch(input, { ...init, headers });
}

export async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  assert.ok(response.ok, `unexpected ${response.status}: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

export function chunkedPut(origin: string, path: string, chunks: readonly Buffer[]): Promise<HttpResult> {
  const { promise, resolve, reject } = Promise.withResolvers<HttpResult>();
  const req = request(new URL(path, origin), {
    method: 'PUT',
    headers: {
      'content-type': 'application/octet-stream',
      'transfer-encoding': 'chunked',
      origin,
      [EDITOR_TOKEN_HEADER]: editorApiToken(),
    },
  }, (res) => {
    const responseChunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => responseChunks.push(chunk));
    res.on('end', () => resolve({
      status: res.statusCode ?? 0,
      body: Buffer.concat(responseChunks).toString('utf8'),
    }));
  });
  req.on('error', reject);
  for (const chunk of chunks) req.write(chunk);
  req.end();
  return promise;
}

export function chunkedHandoffPost(
  origin: string,
  path: string,
  contentType: string,
  chunks: readonly Buffer[],
): Promise<HttpResult> {
  const { promise, resolve, reject } = Promise.withResolvers<HttpResult>();
  const req = request(new URL(path, origin), {
    method: 'POST',
    headers: {
      'content-type': contentType,
      'transfer-encoding': 'chunked',
    },
  }, (res) => {
    const responseChunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => responseChunks.push(chunk));
    res.on('end', () => resolve({
      status: res.statusCode ?? 0,
      body: Buffer.concat(responseChunks).toString('utf8'),
    }));
  });
  req.on('error', reject);
  for (const chunk of chunks) req.write(chunk);
  req.end();
  return promise;
}

export async function multipartInit(
  origin: string,
  body: Record<string, unknown>,
): Promise<{ response: Response; json: Record<string, unknown> }> {
  const response = await editorFetch(`${origin}/upload/multipart/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, json: JSON.parse(await response.text()) as Record<string, unknown> };
}

export async function abortMultipart(origin: string, uploadId: string): Promise<void> {
  const response = await editorFetch(`${origin}/upload/multipart?uploadId=${encodeURIComponent(uploadId)}`, {
    method: 'DELETE',
  });
  assert.equal(response.status, 200, await response.text());
}
