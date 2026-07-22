import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

import { uploadDir } from '../media-dir.ts';

const OUTPUT_FORMATS = new Set([
  'mp3_22050_32', 'mp3_24000_48', 'mp3_44100_32', 'mp3_44100_64',
  'mp3_44100_96', 'mp3_44100_128', 'mp3_44100_192',
  'pcm_8000', 'pcm_16000', 'pcm_22050', 'pcm_24000', 'pcm_32000', 'pcm_44100', 'pcm_48000',
  'ulaw_8000', 'alaw_8000',
  'opus_48000_32', 'opus_48000_64', 'opus_48000_96', 'opus_48000_128', 'opus_48000_192',
]);

interface SoundOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface SoundRequest {
  prompt?: string;
  durationSeconds?: number;
  promptInfluence?: number;
  loop?: boolean;
  outputFormat?: string;
}

export interface ValidSoundRequest {
  prompt: string;
  durationSeconds?: number;
  promptInfluence: number;
  loop: boolean;
  outputFormat: string;
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
export function validateSoundRequest(input: SoundRequest): ValidSoundRequest {
  const prompt = String(input.prompt ?? '').trim();
  const durationSeconds = input.durationSeconds;
  const promptInfluence = input.promptInfluence ?? 0.3;
  const loop = input.loop ?? false;
  const outputFormat = String(input.outputFormat ?? 'mp3_44100_128');
  if (!prompt) throw new Error('prompt is required');
  if (durationSeconds != null && (!Number.isFinite(durationSeconds) || durationSeconds < 0.5 || durationSeconds > 30)) {
    throw new Error('durationSeconds must be between 0.5 and 30');
  }
  if (!Number.isFinite(promptInfluence) || promptInfluence < 0 || promptInfluence > 1) throw new Error('promptInfluence must be between 0 and 1');
  if (typeof loop !== 'boolean') throw new Error('loop must be a boolean');
  if (!OUTPUT_FORMATS.has(outputFormat)) throw new Error(`unsupported ElevenLabs outputFormat ${outputFormat}`);
  return { prompt, durationSeconds, promptInfluence, loop, outputFormat };
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

function rawInput(outputFormat: string): { format: string; rate: string } | undefined {
  const [codec, rate] = outputFormat.split('_');
  if (codec === 'pcm') return { format: 's16le', rate };
  if (codec === 'ulaw') return { format: 'mulaw', rate };
  if (codec === 'alaw') return { format: 'alaw', rate };
  return undefined;
}

async function wrapRawAudio(bytes: Buffer, format: string): Promise<{ file: string; ext: string }> {
  const raw = rawInput(format)!;
  const dir = uploadDir();
  const stem = randomUUID();
  const input = join(dir, `${stem}.raw`);
  const output = join(dir, `${stem}.wav`);
  await writeFile(input, bytes);
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('ffmpeg', ['-y', '-f', raw.format, '-ar', raw.rate, '-ac', '1', '-i', input, output]);
    let error = '';
    child.stderr.on('data', (data) => { error += String(data); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolvePromise() : reject(new Error(error.slice(-500))));
  });
  await unlink(input).catch(() => undefined);
  return { file: output, ext: 'wav' };
}

async function saveAudio(bytes: Buffer, outputFormat: string): Promise<{ path: string; durationSeconds: number }> {
  if (!bytes.length) throw new Error('sound provider returned empty audio');
  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  const raw = rawInput(outputFormat);
  let file: string;
  let ext: string;
  if (raw) ({ file, ext } = await wrapRawAudio(bytes, outputFormat));
  else {
    ext = outputFormat.startsWith('opus_') ? 'opus' : 'mp3';
    file = join(dir, `${randomUUID()}.${ext}`);
    await writeFile(file, bytes);
  }
  const filename = file.split('/').pop()!;
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
          if (input.loop && options.model !== 'eleven_text_to_sound_v2') {
            throw new Error('loop requires ELEVENLABS_SOUND_MODEL eleven_text_to_sound_v2');
          }
          const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/v1/sound-generation?output_format=${encodeURIComponent(input.outputFormat)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'xi-api-key': options.apiKey },
            body: JSON.stringify({
              text: input.prompt,
              ...(input.durationSeconds != null ? { duration_seconds: input.durationSeconds } : {}),
              prompt_influence: input.promptInfluence,
              loop: input.loop,
              model_id: options.model,
            }),
          });
          if (!response.ok) throw new Error(await providerError(response));
          sendJson(res, 200, await saveAudio(Buffer.from(await response.arrayBuffer()), input.outputFormat));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[generate:sound] ${message}`);
          sendJson(res, 400, { error: message });
        }
      });
    },
  };
}
