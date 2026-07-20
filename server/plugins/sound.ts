import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

import { uploadDir } from '../media-dir.ts';

interface SoundOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface SoundRequest {
  prompt?: string;
  durationSeconds?: number;
  promptInfluence?: number;
}

async function readJson(req: IncomingMessage): Promise<SoundRequest> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > 1_000_000) throw new Error('request body too large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as SoundRequest;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function providerError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const data = JSON.parse(text) as { detail?: { message?: string }; error?: { message?: string } };
    return data.detail?.message ?? data.error?.message ?? `sound provider failed (${response.status})`;
  } catch {
    return text.slice(0, 300) || `sound provider failed (${response.status})`;
  }
}

/** Pure validation — exported for unit checks. */
export function validateSoundRequest(input: SoundRequest): Required<SoundRequest> {
  const prompt = String(input.prompt ?? '').trim();
  const durationSeconds = input.durationSeconds ?? 4;
  const promptInfluence = input.promptInfluence ?? 0.3;
  if (!prompt) throw new Error('prompt is required');
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0.5 || durationSeconds > 22) throw new Error('durationSeconds must be between 0.5 and 22');
  if (!Number.isFinite(promptInfluence) || promptInfluence < 0 || promptInfluence > 1) throw new Error('promptInfluence must be between 0 and 1');
  return { prompt, durationSeconds, promptInfluence };
}

const validate = validateSoundRequest;

async function probeDuration(file: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
    let output = '';
    child.stdout.on('data', (data) => { output += String(data); });
    child.on('error', reject);
    child.on('close', (code) => {
      const duration = Number(output.trim());
      if (code === 0 && Number.isFinite(duration) && duration > 0) resolvePromise(duration);
      else reject(new Error('unable to probe generated sound'));
    });
  });
}

async function saveAudio(bytes: Buffer): Promise<{ path: string; durationSeconds: number }> {
  if (!bytes.length) throw new Error('sound provider returned empty audio');
  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  const filename = `${randomUUID()}.mp3`;
  const file = join(dir, filename);
  await writeFile(file, bytes);
  return { path: `/media/uploads/${filename}`, durationSeconds: await probeDuration(file) };
}

export function soundGenerationPlugin(options: SoundOptions): Plugin {
  return {
    name: 'openchatcut-sound-generation',
    configureServer(server) {
      server.middlewares.use('/generate/sound', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed — use POST' }); return; }
        try {
          if (!options.apiKey) throw new Error('Sound generation is not configured. Set ELEVENLABS_API_KEY in .env.local.');
          const input = validate(await readJson(req));
          const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/v1/sound-generation?output_format=mp3_44100_128`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'xi-api-key': options.apiKey },
            body: JSON.stringify({ text: input.prompt, duration_seconds: input.durationSeconds, prompt_influence: input.promptInfluence, model_id: options.model }),
          });
          if (!response.ok) throw new Error(await providerError(response));
          sendJson(res, 200, await saveAudio(Buffer.from(await response.arrayBuffer())));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[generate:sound] ${message}`);
          sendJson(res, 400, { error: message });
        }
      });
    },
  };
}
