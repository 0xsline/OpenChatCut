// POST /api/normalize-media — compatibility normalization with opt-in media optimization.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { basename, extname, join } from 'node:path';
import {
  isSafeUploadName, resolveUploadFile, resolveUploadReference, uploadDir,
} from '../media-dir.ts';
import {
  NormalizeAdmissionFullError,
  type NormalizeAdmission,
  type NormalizeEncodeContext,
} from '../media-normalization.ts';
import {
  normalizeMediaFile,
  NormalizeMediaProbeError,
} from '../media-normalization-runner.ts';

export {
  createNormalizeAdmission,
  createNormalizeTempPath,
  isVariableFrameRate,
  parseFrameRate,
  playableDurationSeconds,
  resolveNormalizeOutputPath,
  resolveNormalizeTargetKey,
  resolveStreamPlan,
  resolveTargetFps,
} from '../media-normalization.ts';
export type { NormalizeEncodeContext } from '../media-normalization.ts';

const MAX_JSON = 8 * 1024;
const VIDEO_EXTENSIONS: Record<string, true> = {
  '.mp4': true,
  '.mov': true,
  '.webm': true,
  '.mkv': true,
  '.m4v': true,
  '.avi': true,
  '.mpeg': true,
  '.mpg': true,
};
const PASSTHROUGH_EXTENSIONS: Record<string, true> = {
  '.jpg': true,
  '.jpeg': true,
  '.png': true,
  '.gif': true,
  '.webp': true,
  '.svg': true,
  '.mp3': true,
  '.wav': true,
  '.m4a': true,
  '.aac': true,
  '.ogg': true,
  '.flac': true,
  '.opus': true,
  '.cube': true,
  '.json': true,
};

export interface NormalizeMediaPluginOptions {
  readonly admission?: NormalizeAdmission;
  readonly encoderHook?: (
    context: NormalizeEncodeContext,
    encode: () => Promise<void>,
  ) => Promise<void>;
}

interface NormalizeRequestBody {
  readonly src?: string;
  readonly force?: boolean;
  readonly optimize?: boolean;
  readonly forceCfr?: boolean;
  readonly targetFps?: number;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage, max = MAX_JSON): Promise<unknown> {
  const deferred = Promise.withResolvers<unknown>();
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > max) {
      deferred.reject(new Error('body too large'));
      req.destroy();
    } else {
      chunks.push(chunk);
    }
  });
  req.on('end', () => {
    try {
      deferred.resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
    } catch (error) {
      deferred.reject(error);
    }
  });
  req.on('error', deferred.reject);
  return deferred.promise;
}

function uploadNameFromSrc(src: string): string | null {
  const clean = decodeURIComponent((src.split('?')[0] ?? '').trim());
  const match = clean.match(/^\/media\/uploads\/([^/]+)$/);
  if (!match) return null;
  return isSafeUploadName(match[1]) ? match[1] : null;
}

function bindRequestAbort(req: IncomingMessage, res: ServerResponse): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const abort = (): void => controller.abort(new DOMException('normalize request closed', 'AbortError'));
  const close = (): void => { if (!res.writableEnded) abort(); };
  req.once('aborted', abort);
  res.once('close', close);
  return {
    signal: controller.signal,
    dispose: () => {
      req.removeListener('aborted', abort);
      res.removeListener('close', close);
    },
  };
}

function isPassthrough(name: string): boolean {
  return name.includes('.asr.') || extname(name).toLowerCase() in PASSTHROUGH_EXTENSIONS;
}

function sendNormalizeError(
  res: ServerResponse,
  error: unknown,
  log: (message: string) => void,
): void {
  if (error instanceof NormalizeAdmissionFullError) {
    sendJson(res, 429, { error: error.message, code: 'NORMALIZE_QUEUE_FULL' });
    return;
  }
  if (error instanceof NormalizeMediaProbeError) {
    sendJson(res, 422, { error: error.message, code: 'MEDIA_PROBE_FAILED' });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  log(`[normalize-media] ${message}`);
  const status = /ENOENT|spawn .*ffmpeg|spawn .*ffprobe/i.test(message) ? 503 : 500;
  sendJson(res, status, { error: message });
}

interface NormalizeRouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly body: NormalizeRequestBody;
  readonly src: string;
  readonly inputPath: string;
  readonly outputPath?: string;
  readonly options: NormalizeMediaPluginOptions;
  readonly logger: { info(message: string): void; error(message: string): void };
}

async function normalizeVideoRequest(context: NormalizeRouteContext): Promise<void> {
  const abort = bindRequestAbort(context.req, context.res);
  try {
    const result = await normalizeMediaFile({
      inputPath: context.inputPath,
      publicSrc: context.src,
      outputPath: context.outputPath,
      preserveInput: context.outputPath !== undefined,
      force: context.body.force,
      optimize: context.body.optimize,
      forceCfr: context.body.forceCfr,
      targetFps: context.body.targetFps,
      signal: abort.signal,
      admission: context.options.admission,
      encoderHook: context.options.encoderHook,
      publishR2: true,
      uploadsDirectory: uploadDir(),
      logInfo: (message) => context.logger.info(message),
      logError: (message) => context.logger.error(message),
    });
    if (!abort.signal.aborted) {
      sendJson(context.res, 200, {
        ok: true,
        path: result.path,
        normalized: result.normalized,
        reason: result.reason,
        bytes: result.bytes,
        bytesBefore: result.bytesBefore,
        width: result.width,
        height: result.height,
        durationSeconds: result.durationSeconds,
        videoFrameCount: result.videoFrameCount,
        fps: result.sourceFps,
        variableFrameRate: result.variableFrameRate,
      });
    }
  } catch (error) {
    if (!abort.signal.aborted) {
      sendNormalizeError(context.res, error, (message) => context.logger.error(message));
    }
  } finally {
    abort.dispose();
  }
}


async function handleNormalizeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: NormalizeMediaPluginOptions,
  logger: { info(message: string): void; error(message: string): void },
): Promise<void> {
  const body = (await readJson(req)) as NormalizeRequestBody;
  const src = String(body.src ?? '').trim();
  const name = uploadNameFromSrc(src);
  if (!name) {
    sendJson(res, 400, { error: 'src must be /media/uploads/<safe-name>' });
    return;
  }
  const inputPath = resolveUploadFile(name);
  if (!inputPath) {
    sendJson(res, 404, { error: `media not found: ${name}` });
    return;
  }
  const extension = extname(name).toLowerCase();
  if (isPassthrough(name)) {
    sendJson(res, 200, { ok: true, path: src, normalized: false, reason: 'not a video master' });
    return;
  }
  if (!(extension in VIDEO_EXTENSIONS) && !body.force) {
    sendJson(res, 200, { ok: true, path: src, normalized: false, reason: 'skip non-video extension' });
    return;
  }
  const referenced = resolveUploadReference(name);
  const outputPath = referenced
    ? join(uploadDir(), `${basename(name, extension)}.normalized.mp4`)
    : undefined;
  await normalizeVideoRequest({ req, res, body, src, inputPath, outputPath, options, logger });
}

export function normalizeMediaPlugin(options: NormalizeMediaPluginOptions = {}): Plugin {
  return {
    name: 'openchatcut-normalize-media',
    configureServer(server) {
      server.middlewares.use('/api/normalize-media', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed — use POST' });
          return;
        }
        await handleNormalizeRequest(req, res, options, server.config.logger);
      });
    },
  };
}
