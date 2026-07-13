import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { createGenerationJob, type GenerationResult } from './vite-generation-jobs.ts';

const UPLOAD_DIR = resolve(process.cwd(), 'public/media/uploads');
const TERMINAL_FAILURES = new Set(['failed', 'timeouted', 'cancelled']);

interface MusicOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface MusicRequest {
  prompt?: string;
  name?: string;
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

async function saveAudio(response: Response): Promise<{ path: string; durationSeconds: number }> {
  if (!response.ok) throw new Error(await providerError(response));
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error('music provider returned empty audio');
  await mkdir(UPLOAD_DIR, { recursive: true });
  const filename = `${randomUUID()}.mp3`;
  const file = join(UPLOAD_DIR, filename);
  await writeFile(file, bytes);
  return { path: `/media/uploads/${filename}`, durationSeconds: await probeDuration(file) };
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

export function musicGenerationPlugin(options: MusicOptions): Plugin {
  return {
    name: 'chatcut-music-generation',
    configureServer(server) {
      server.middlewares.use('/generate/music', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed — use POST' }); return; }
        try {
          if (!options.apiKey) throw new Error('Music generation is not configured. Set MUREKA_API_KEY in .env.local.');
          const request = await readJson(req);
          const prompt = String(request.prompt ?? '').trim();
          if (!prompt) throw new Error('prompt is required');
          if (prompt.length > 1024) throw new Error('prompt must be at most 1024 characters');
          const name = String(request.name ?? '').trim() || `Music · ${prompt.slice(0, 36)}`;
          const baseUrl = options.baseUrl.replace(/\/$/, '');
          const submission = createGenerationJob({ kind: 'music', prompt, name, model: options.model }, async (jobId): Promise<GenerationResult> => {
            const response = await fetch(`${baseUrl}/v1/instrumental/generate`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: options.model, prompt }),
            });
            if (!response.ok) throw new Error(await providerError(response));
            const audioUrl = await awaitAudioUrl(baseUrl, options.apiKey, await response.json() as MurekaTask);
            const saved = await saveAudio(await fetch(audioUrl));
            return { assetId: jobId, kind: 'audio', name, ...saved };
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
