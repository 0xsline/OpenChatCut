import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { isSequenceGraphError } from '../../src/editor/sequenceGraph.ts';
import {
  type ExportFailure,
} from '../../src/export/exportFailure.ts';
import type { ExportRequest } from './export-plan.ts';

const MAX_BODY_BYTES = 32 * 1024 * 1024; // 32MB — timelines carry inlined template code.

// RFC 5987: filename= is a latin-1 field. If Chinese UTF-8 bytes are inserted directly, the browser will press latin-1
// decode into gibberish. Give an ASCII backend filename= + filename*=UTF-8'' percent encoding (same as server/plugins/captions).
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export function exportOperationId(body: ExportRequest | null): string | undefined {
  if (body?.operationId === undefined) return undefined;
  if (typeof body.operationId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.operationId)) {
    throw new Error('export operationId must be a UUID');
  }
  return body.operationId;
}

export function bindRequestAbort(req: IncomingMessage, res: ServerResponse): {
  controller: AbortController;
  dispose(): void;
} {
  const controller = new AbortController();
  const abort = () => {
    if (!res.writableFinished) controller.abort(new DOMException('Client disconnected', 'AbortError'));
  };
  req.once('aborted', abort);
  res.once('close', abort);
  if (req.aborted) abort();
  return {
    controller,
    dispose() {
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
    },
  };
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: message }));
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export function sendSequenceGraphFailure(res: ServerResponse, error: unknown): boolean {
  if (!isSequenceGraphError(error)) return false;
  sendJson(res, 422, {
    error: error.message,
    code: error.code,
    path: error.path,
    limit: error.limit,
    itemId: error.itemId,
    timelineId: error.timelineId,
    referencedTimelineId: error.referencedTimelineId,
    parentFps: error.parentFps,
    childFps: error.childFps,
  });
  return true;
}

export function sendExportFailure(res: ServerResponse, status: number, failure: ExportFailure): void {
  sendJson(res, status, { error: failure.message, failure });
}

export interface ExportDownload {
  mime: string;
  filename: string;
  signal?: AbortSignal;
}

/**
 * Deliver a finished render by streaming it to the client.
 *
 * The route used to pull the whole output into one Buffer with `readFile`.
 * Node rejects that for files ≥2 GiB (`ERR_FS_FILE_TOO_LARGE`) *after* the
 * render has finished, so a ~3.4 GiB hour-long 1080p export failed and — via
 * the route's cleanup — deleted itself. Streaming removes the ceiling and keeps
 * a multi-GB allocation out of the dev-server process.
 *
 * `Content-Length` comes from `stat`, so the client still sees the size up front
 * (progress UIs and truncation detection keep working) instead of a chunked,
 * length-less body. The read handle is closed on every path: completion, abort,
 * or a socket error mid-copy.
 */
export async function streamExportFile(
  res: ServerResponse,
  file: string,
  download: ExportDownload,
): Promise<void> {
  const { size } = await stat(file);
  download.signal?.throwIfAborted();
  res.statusCode = 200;
  res.setHeader('Content-Type', download.mime);
  res.setHeader('Content-Length', String(size));
  res.setHeader('Content-Disposition', contentDisposition(download.filename));
  if (size === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(file);
  try {
    await pipeline(stream, res, download.signal ? { signal: download.signal } : {});
  } catch (error) {
    // The headers are already on the wire, so this can no longer become a JSON
    // error body. Destroying the response makes the truncated transfer visible
    // to the client (Content-Length was announced) instead of a hung socket.
    res.destroy();
    throw error;
  } finally {
    stream.destroy();
  }
}
