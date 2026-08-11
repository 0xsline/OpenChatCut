import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname } from 'node:path';
import {
  effectiveUploadMaxBytes, r2PresignEnabled, UploadTooLargeError,
} from '../r2.ts';
import { isSafeUploadName } from '../media-dir.ts';

const MAX_JSON_BYTES = 64 * 1024;

export function maxUploadBytes(): number {
  return effectiveUploadMaxBytes();
}

/** Direct R2 PUT cannot enforce the finite application byte cap, so use the bounded proxy. */
export function directR2UploadAllowed(_presignEnabled = r2PresignEnabled()): boolean {
  return false;
}

function readBody(req: IncomingMessage, max = MAX_JSON_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        reject(new UploadTooLargeError(max));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}


function contentLengthOf(req: IncomingMessage): number | null {
  const raw = req.headers['content-length'];
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}


const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/svg+xml': '.svg', 'audio/mpeg': '.mp3',
  'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/mp4': '.m4a',
  'audio/aac': '.aac', 'audio/ogg': '.ogg',
};

function extFromUrlOrType(url: string, contentType: string | null, hint?: string): string {
  if (hint) {
    const extension = extname(hint).toLowerCase().replace(/[^.a-z0-9]/g, '');
    if (extension) return extension;
  }
  const clean = url.split('?')[0].split('#')[0];
  const fromUrl = extname(clean).toLowerCase().replace(/[^.a-z0-9]/g, '');
  if (fromUrl && fromUrl.length <= 6) return fromUrl;
  const base = contentType?.split(';')[0].trim().toLowerCase();
  return (base && CONTENT_TYPE_EXTENSIONS[base]) || '.bin';
}

function mediaName(req: IncomingMessage): string | null {
  try {
    const name = decodeURIComponent((req.url ?? '/').split('?')[0].replace(/^\/+/, ''));
    return isSafeUploadName(name) ? name : null;
  } catch {
    return null;
  }
}

export {
  contentLengthOf,
  extFromUrlOrType,
  mediaName,
  readBody,
  sendError,
  sendJson,
};
