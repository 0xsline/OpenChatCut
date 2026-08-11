import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

import { editorCredentialAuthorized } from '../editor-auth.ts';

import {
  assertTranscriptionProviderConfigured,
  TranscriptionConfigurationError,
  transcribeCloudAudio,
} from './transcription-providers.ts';
import {
  isCloudTranscriptionProvider,
  type CloudTranscriptionProvider,
  type TranscriptionOptions,
} from './transcription-types.ts';

export const MAX_TRANSCRIPTION_BYTES = 100 * 1024 * 1024;

class TranscriptionRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function rejectBeforeBody(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  error: string,
): void {
  req.resume();
  sendJson(res, status, { error });
}

function hasBinaryContentType(req: IncomingMessage): boolean {
  const value = req.headers['content-type'];
  return typeof value === 'string' && value.trim().toLowerCase() === 'application/octet-stream';
}

function assertDeclaredAudioSize(req: IncomingMessage): void {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_TRANSCRIPTION_BYTES) {
    throw new TranscriptionRequestError(413, 'audio body is too large (maximum 100 MiB)');
  }
}

async function readAudio(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_TRANSCRIPTION_BYTES) {
      throw new TranscriptionRequestError(413, 'audio body is too large (maximum 100 MiB)');
    }
    chunks.push(bytes);
  }
  const audio = Buffer.concat(chunks);
  if (!audio.length) throw new TranscriptionRequestError(400, 'audio body is required');
  return audio;
}

function requestProvider(url: URL): CloudTranscriptionProvider {
  const provider = (url.searchParams.get('provider') ?? '').trim();
  if (!isCloudTranscriptionProvider(provider)) {
    throw new TranscriptionRequestError(400, 'provider must be openai, deepgram, groq, elevenlabs, or cartesia');
  }
  return provider;
}

function requestLanguage(url: URL, fallback: string): string {
  const language = (url.searchParams.get('language') ?? fallback).trim();
  if (!/^(?:auto|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.test(language)) {
    throw new TranscriptionRequestError(400, 'language must be an ISO language code or auto');
  }
  return language;
}

function requestDiarization(url: URL, fallback: boolean): boolean {
  const value = url.searchParams.get('diarize');
  if (value == null) return fallback;
  if (value === '0') return false;
  if (value === '1') return true;
  throw new TranscriptionRequestError(400, 'diarize must be 0 or 1');
}

async function handleTranscription(
  req: IncomingMessage,
  res: ServerResponse,
  options: TranscriptionOptions,
  logger: { error(message: string): void },
): Promise<void> {
  if (req.method !== 'POST') {
    rejectBeforeBody(req, res, 405, 'method not allowed — use POST');
    return;
  }
  if (!editorCredentialAuthorized(req, true)) {
    rejectBeforeBody(req, res, 401, 'editor credential required');
    return;
  }
  if (!hasBinaryContentType(req)) {
    rejectBeforeBody(req, res, 415, 'content-type must be application/octet-stream');
    return;
  }
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const provider = requestProvider(url);
    const language = requestLanguage(url, options.language);
    const diarize = requestDiarization(url, options.diarization);
    assertDeclaredAudioSize(req);
    assertTranscriptionProviderConfigured(options, provider);
    const audio = await readAudio(req);
    const result = await transcribeCloudAudio(options, { provider, language, diarize, audio });
    sendJson(res, 200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[api:transcribe] ${message}`);
    if (error instanceof TranscriptionRequestError) sendJson(res, error.status, { error: message });
    else if (error instanceof TranscriptionConfigurationError) sendJson(res, 400, { error: message });
    else sendJson(res, 502, { error: 'transcription provider request failed — check the provider settings and audio format' });
  }
}

export function transcriptionPlugin(options: TranscriptionOptions): Plugin {
  return {
    name: 'openchatcut-transcription',
    configureServer(server) {
      server.middlewares.use('/api/transcribe', (req, res) => {
        void handleTranscription(req, res, options, server.config.logger);
      });
    },
  };
}
