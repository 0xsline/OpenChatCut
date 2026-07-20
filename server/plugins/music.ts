import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import type { Plugin } from 'vite';
import { createGenerationJob, type GenerationResult } from './generation-jobs.ts';

import { isSafeUploadName, resolveUploadFile, uploadDir } from '../media-dir.ts';
const TERMINAL_FAILURES = new Set(['failed', 'timeouted', 'cancelled']);

const MINIMAX_SAMPLE_RATES = new Set([16_000, 24_000, 32_000, 44_100]);
const MINIMAX_BITRATES = new Set([32_000, 64_000, 128_000, 256_000]);
const MINIMAX_FORMATS = new Set(['mp3', 'wav', 'pcm']);

interface MusicOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  minimaxBaseUrl: string;
  minimaxApiKey: string;
  minimaxModel: string;
}

interface MusicRequest {
  prompt?: string;
  name?: string;
  provider?: string;
  lyrics?: string;
  /** MiniMax only: force instrumental (default true when no lyrics / no lyricsOptimizer). */
  isInstrumental?: boolean;
  /** MiniMax only: auto-generate lyrics from prompt when lyrics empty (official lyrics_optimizer). */
  lyricsOptimizer?: boolean;
  /** MiniMax only: audio_setting.sample_rate */
  sampleRate?: number;
  /** MiniMax only: audio_setting.bitrate */
  bitrate?: number;
  /** MiniMax only: audio_setting.format */
  audioFormat?: 'mp3' | 'wav' | 'pcm';
  /** MiniMax music-cover: project upload path for reference audio (`/media/uploads/...`). */
  referenceAudioPath?: string;
}

export interface ValidMusicRequest {
  provider: 'mureka' | 'minimax';
  prompt: string;
  name: string;
  lyrics?: string;
  isInstrumental: boolean;
  lyricsOptimizer: boolean;
  sampleRate: number;
  bitrate: number;
  audioFormat: 'mp3' | 'wav' | 'pcm';
  /** When set, this is a music-cover job (needs music-cover model in settings). */
  referenceAudioPath?: string;
  coverMode: boolean;
}

/** MiniMax music-cover / music-cover-free models need a reference track. */
export function isMinimaxCoverModel(modelName: string): boolean {
  return /music-cover/i.test(modelName);
}

interface MurekaTask {
  id?: string;
  status?: string;
  failed_reason?: string;
  choices?: Array<{ audio_url?: string; url?: string; wav_url?: string; flac_url?: string }>;
}

async function readJson(req: IncomingMessage): Promise<MusicRequest> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > 1_000_000) throw new Error('request body too large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as MusicRequest;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function providerError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const data = JSON.parse(text) as { message?: string; detail?: string; error?: { message?: string } };
    return data.error?.message ?? data.message ?? data.detail ?? `music provider failed (${response.status})`;
  } catch {
    return text.slice(0, 300) || `music provider failed (${response.status})`;
  }
}

async function probeDuration(file: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
    let output = '';
    child.stdout.on('data', (data) => { output += String(data); });
    child.on('error', reject);
    child.on('close', (code) => {
      const duration = Number(output.trim());
      if (code === 0 && Number.isFinite(duration) && duration > 0) resolvePromise(duration);
      else reject(new Error('unable to probe generated music'));
    });
  });
}

async function saveAudio(response: Response, ext = 'mp3'): Promise<{ path: string; durationSeconds: number }> {
  if (!response.ok) throw new Error(await providerError(response));
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error('music provider returned empty audio');
  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  const safeExt = ext === 'wav' || ext === 'pcm' ? ext : 'mp3';
  const filename = `${randomUUID()}.${safeExt === 'pcm' ? 'pcm' : safeExt}`;
  const file = join(dir, filename);
  await writeFile(file, bytes);
  // pcm may not probe; fall back to 0 so the asset still lands (duration fill later if needed)
  let durationSeconds = 0;
  try {
    durationSeconds = await probeDuration(file);
  } catch {
    if (safeExt === 'mp3' || safeExt === 'wav') throw new Error('unable to probe generated music');
  }
  return { path: `/media/uploads/${filename}`, durationSeconds };
}

const wait = (milliseconds: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function fetchTask(url: string, apiKey: string): Promise<MurekaTask> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(await providerError(response));
  return response.json() as Promise<MurekaTask>;
}

async function awaitAudioUrl(baseUrl: string, apiKey: string, initial: MurekaTask): Promise<string> {
  if (!initial.id) throw new Error('music provider did not return a task id');
  const deadline = Date.now() + 5 * 60_000;
  let task = initial;
  while (Date.now() < deadline) {
    if (task.status === 'succeeded') {
      const audioUrl = pickMurekaAudioUrl(task);
      if (!audioUrl) throw new Error('music provider succeeded without an audio URL');
      return audioUrl;
    }
    if (task.status && TERMINAL_FAILURES.has(task.status)) {
      throw new Error(task.failed_reason || `music generation ${task.status}`);
    }
    await wait(2_000);
    task = await fetchTask(`${baseUrl}/v1/instrumental/query/${encodeURIComponent(initial.id)}`, apiKey);
  }
  throw new Error('music generation timed out');
}

export function pickMurekaAudioUrl(task: MurekaTask): string | undefined {
  const choice = task.choices?.[0];
  return choice?.audio_url ?? choice?.url ?? choice?.wav_url ?? choice?.flac_url;
}

/** Pure validation for music jobs — exported for checks. */
export function validateMusicRequest(input: MusicRequest): ValidMusicRequest {
  const provider = String(input.provider ?? 'mureka');
  if (provider !== 'mureka' && provider !== 'minimax') throw new Error('provider must be mureka or minimax');
  const prompt = String(input.prompt ?? '').trim();
  if (!prompt) throw new Error('prompt is required');

  const referenceAudioPath = String(input.referenceAudioPath ?? '').trim() || undefined;
  if (referenceAudioPath && provider !== 'minimax') {
    throw new Error('referenceAudioPath is supported by minimax music-cover only');
  }
  if (referenceAudioPath && !referenceAudioPath.startsWith('/media/uploads/')) {
    throw new Error('referenceAudioPath must be a project upload under /media/uploads/');
  }
  const coverMode = Boolean(referenceAudioPath);

  // Official: cover style prompt 10–300 chars; t2m instrumental/vocals up to 2000; mureka 1024.
  const maxPrompt = coverMode ? 300 : provider === 'minimax' ? 2000 : 1024;
  const minPrompt = coverMode ? 10 : 1;
  if (prompt.length < minPrompt) throw new Error(coverMode ? 'music-cover prompt must be at least 10 characters' : 'prompt is required');
  if (prompt.length > maxPrompt) throw new Error(`prompt must be at most ${maxPrompt} characters`);

  const lyrics = String(input.lyrics ?? '').trim() || undefined;
  if (lyrics && provider !== 'minimax') throw new Error('lyrics are only supported by the minimax provider');
  if (lyrics && !coverMode && lyrics.length > 3500) throw new Error('lyrics must be at most 3500 characters');
  // Official cover lyrics optional 10–1000 when provided
  if (lyrics && coverMode && (lyrics.length < 10 || lyrics.length > 1000)) {
    throw new Error('music-cover lyrics must be 10–1000 characters when provided');
  }

  const lyricsOptimizer = input.lyricsOptimizer === true;
  if (lyricsOptimizer && provider !== 'minimax') throw new Error('lyricsOptimizer is supported by minimax only');
  if (lyricsOptimizer && coverMode) throw new Error('lyricsOptimizer is not used for music-cover (pass lyrics or omit for ASR)');

  // Defaults: instrumental when no lyrics and not optimizing lyrics (BGM-friendly). Cover ignores instrumental flags.
  let isInstrumental: boolean;
  if (coverMode) {
    if (input.isInstrumental === true) throw new Error('isInstrumental is not used for music-cover');
    isInstrumental = false;
  } else if (provider === 'mureka') {
    isInstrumental = true;
    if (input.isInstrumental === false) throw new Error('mureka is instrumental-only');
  } else if (typeof input.isInstrumental === 'boolean') {
    isInstrumental = input.isInstrumental;
  } else {
    isInstrumental = !lyrics && !lyricsOptimizer;
  }

  if (!coverMode && provider === 'minimax' && !isInstrumental && !lyrics && !lyricsOptimizer) {
    throw new Error('minimax vocals require lyrics, or lyricsOptimizer:true to auto-generate lyrics, or isInstrumental:true');
  }
  if (isInstrumental && lyrics) {
    throw new Error('isInstrumental:true cannot be combined with lyrics');
  }
  if (isInstrumental && lyricsOptimizer) {
    throw new Error('isInstrumental:true cannot be combined with lyricsOptimizer');
  }

  const sampleRate = input.sampleRate ?? 44_100;
  const bitrate = input.bitrate ?? 256_000;
  const audioFormat = input.audioFormat ?? 'mp3';
  if (provider === 'minimax') {
    if (!MINIMAX_SAMPLE_RATES.has(sampleRate)) throw new Error('sampleRate must be 16000, 24000, 32000, or 44100');
    if (!MINIMAX_BITRATES.has(bitrate)) throw new Error('bitrate must be 32000, 64000, 128000, or 256000');
    if (!MINIMAX_FORMATS.has(audioFormat)) throw new Error('audioFormat must be mp3, wav, or pcm');
  } else if (input.sampleRate != null || input.bitrate != null || input.audioFormat != null) {
    throw new Error('sampleRate/bitrate/audioFormat are supported by minimax only');
  }

  const name = String(input.name ?? '').trim() || `Music · ${prompt.slice(0, 36)}`;
  return {
    provider,
    prompt,
    name,
    lyrics,
    isInstrumental,
    lyricsOptimizer,
    sampleRate,
    bitrate,
    audioFormat: audioFormat as 'mp3' | 'wav' | 'pcm',
    referenceAudioPath,
    coverMode,
  };
}

interface MinimaxMusicResponse {
  data?: { audio?: string };
  base_resp?: { status_code?: number; status_msg?: string };
}

function audioMime(path: string): string {
  const ext = extname(path).slice(1).toLowerCase();
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'flac') return 'audio/flac';
  if (ext === 'm4a' || ext === 'mp4') return 'audio/mp4';
  if (ext === 'ogg') return 'audio/ogg';
  return 'audio/mpeg';
}

async function referenceAudioDataUrl(uploadPath: string): Promise<string> {
  const name = uploadPath.slice('/media/uploads/'.length);
  if (!isSafeUploadName(name)) throw new Error('invalid reference audio path');
  const file = resolveUploadFile(name);
  if (!file) throw new Error(`reference audio not found: ${uploadPath}`);
  const bytes = await readFile(file);
  if (bytes.length > 50 * 1024 * 1024) throw new Error('reference audio must be at most 50MB');
  if (!bytes.length) throw new Error('reference audio is empty');
  return `data:${audioMime(file)};base64,${bytes.toString('base64')}`;
}

/** MiniMax music_generation is synchronous — returns the generated track's URL. */
async function minimaxMusicUrl(options: MusicOptions, input: ValidMusicRequest): Promise<string> {
  if (input.coverMode && !isMinimaxCoverModel(options.minimaxModel)) {
    throw new Error('music-cover requires MINIMAX_MUSIC_MODEL music-cover or music-cover-free (Settings → 生音乐)');
  }
  if (!input.coverMode && isMinimaxCoverModel(options.minimaxModel)) {
    throw new Error('music-cover model requires referenceAssetId / referenceAudioPath (source track to cover)');
  }

  const body: Record<string, unknown> = {
    model: options.minimaxModel,
    prompt: input.prompt,
    output_format: 'url',
    audio_setting: {
      sample_rate: input.sampleRate,
      bitrate: input.bitrate,
      format: input.audioFormat,
    },
  };

  if (input.coverMode && input.referenceAudioPath) {
    // Official music-cover: reference via audio_base64 (or url); style in prompt; optional lyrics.
    body.audio_base64 = await referenceAudioDataUrl(input.referenceAudioPath);
    if (input.lyrics) body.lyrics = input.lyrics;
  } else if (input.isInstrumental) {
    body.is_instrumental = true;
  } else {
    body.is_instrumental = false;
    if (input.lyrics) body.lyrics = input.lyrics;
    if (input.lyricsOptimizer) body.lyrics_optimizer = true;
  }

  const response = await fetch(`${options.minimaxBaseUrl.replace(/\/$/, '')}/v1/music_generation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.minimaxApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await providerError(response));
  const result = await response.json() as MinimaxMusicResponse;
  if (result.base_resp && result.base_resp.status_code !== 0) {
    throw new Error(result.base_resp.status_msg || `MiniMax music failed (${result.base_resp.status_code})`);
  }
  if (!result.data?.audio) throw new Error('MiniMax returned no audio');
  return result.data.audio;
}

export function musicGenerationPlugin(options: MusicOptions): Plugin {
  return {
    name: 'openchatcut-music-generation',
    configureServer(server) {
      server.middlewares.use('/generate/music', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed — use POST' }); return; }
        try {
          const input = validateMusicRequest(await readJson(req));
          if (input.provider === 'minimax') {
            if (!options.minimaxApiKey) throw new Error('MiniMax is not configured. Set MINIMAX_API_KEY in .env.local or 设置面板.');
            // Synchronous provider wrapped in the shared job queue — completes on first poll.
            const submission = createGenerationJob({
              kind: 'music', provider: input.provider, prompt: input.prompt, name: input.name, model: options.minimaxModel,
            }, async (jobId): Promise<GenerationResult> => {
              const saved = await saveAudio(await fetch(await minimaxMusicUrl(options, input)), input.audioFormat);
              return { assetId: jobId, kind: 'audio', name: input.name, ...saved };
            });
            sendJson(res, 202, submission);
            return;
          }
          if (!options.apiKey) throw new Error('Music generation is not configured. Set MUREKA_API_KEY in .env.local.');
          const baseUrl = options.baseUrl.replace(/\/$/, '');
          const submission = createGenerationJob({ kind: 'music', prompt: input.prompt, name: input.name, model: options.model }, async (jobId): Promise<GenerationResult> => {
            const response = await fetch(`${baseUrl}/v1/instrumental/generate`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: options.model, prompt: input.prompt }),
            });
            if (!response.ok) throw new Error(await providerError(response));
            const audioUrl = await awaitAudioUrl(baseUrl, options.apiKey, await response.json() as MurekaTask);
            const saved = await saveAudio(await fetch(audioUrl));
            return { assetId: jobId, kind: 'audio', name: input.name, ...saved };
          });
          sendJson(res, 202, submission);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[generate:music] ${message}`);
          sendJson(res, 400, { error: message });
        }
      });
    },
  };
}
