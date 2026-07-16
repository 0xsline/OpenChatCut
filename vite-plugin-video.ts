import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { createGenerationJob, type GenerationResult } from './vite-generation-jobs.ts';

const UPLOAD_DIR = resolve(process.cwd(), 'public/media/uploads');
const VIDEO_FAILURES = new Set(['failed', 'expired', 'cancelled']);

interface VideoOptions {
  seedanceBaseUrl: string;
  seedanceApiKey: string;
  seedanceModel: string;
  klingBaseUrl: string;
  klingApiKey: string;
  klingModel: string;
  minimaxBaseUrl: string;
  minimaxApiKey: string;
  minimaxModel: string;
}

interface MultiPrompt {
  prompt: string;
  duration: number | string;
  index: number;
}

interface VideoRequest {
  model?: 'seedance2' | 'kling' | 'hailuo';
  prompt?: string;
  name?: string;
  durationSeconds?: number | string;
  ratio?: string;
  resolution?: '720p' | '1080p';
  mode?: 'std' | 'pro';
  firstFramePath?: string;
  lastFramePath?: string;
  refImagePaths?: string[];
  refVideoPaths?: string[];
  refAudioPaths?: string[];
  multiPrompts?: MultiPrompt[];
  shotType?: 'customize' | 'intelligence';
}

interface ValidVideoRequest extends Omit<VideoRequest, 'model' | 'prompt' | 'durationSeconds' | 'ratio' | 'refImagePaths' | 'refVideoPaths' | 'refAudioPaths'> {
  model: 'seedance2' | 'kling' | 'hailuo';
  prompt: string;
  durationSeconds: number;
  ratio: string;
  refImagePaths: string[];
  refVideoPaths: string[];
  refAudioPaths: string[];
}

async function readJson(req: IncomingMessage): Promise<VideoRequest> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > 1_000_000) throw new Error('request body too large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as VideoRequest;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function providerError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const data = JSON.parse(text) as { message?: string; error?: { message?: string }; code?: number };
    return data.error?.message ?? data.message ?? `video provider failed (${data.code ?? response.status})`;
  } catch {
    return text.slice(0, 300) || `video provider failed (${response.status})`;
  }
}

function seconds(value: number | string | undefined, fallback: number): number {
  const parsed = typeof value === 'string' ? Number(value.trim().replace(/s$/i, '')) : value ?? fallback;
  if (!Number.isInteger(parsed)) throw new Error('durationSeconds must be an integer');
  return parsed;
}

function validate(input: VideoRequest): ValidVideoRequest {
  if (input.model !== 'seedance2' && input.model !== 'kling' && input.model !== 'hailuo') throw new Error('model must be seedance2, kling, or hailuo');
  const model = input.model;
  const prompt = String(input.prompt ?? '').trim();
  const durationSeconds = seconds(input.durationSeconds, model === 'hailuo' ? 6 : 5);
  const ratio = String(input.ratio ?? '16:9');
  const refImagePaths = input.refImagePaths ?? [];
  const refVideoPaths = input.refVideoPaths ?? [];
  const refAudioPaths = input.refAudioPaths ?? [];
  if (model === 'hailuo') {
    // MiniMax Hailuo: prompt ≤ 2000, 6s/10s clips, optional first-frame image only —
    // no last frame, references, or multi-shot; framing follows resolution/first frame (no ratio param).
    if (!prompt) throw new Error('prompt is required');
    if (prompt.length > 2000) throw new Error('hailuo prompt must be at most 2000 characters');
    if (durationSeconds !== 6 && durationSeconds !== 10) throw new Error('hailuo durationSeconds must be 6 or 10');
    if (input.lastFramePath || refImagePaths.length || refVideoPaths.length || refAudioPaths.length) throw new Error('hailuo supports an optional firstFrame image only; other references are not supported');
    if (input.mode || input.shotType || input.multiPrompts?.length) throw new Error('mode and multi-shot parameters are supported by kling only');
    return { ...input, model, prompt, durationSeconds, ratio, refImagePaths, refVideoPaths, refAudioPaths };
  }
  const minDuration = model === 'seedance2' ? 4 : 3;
  const ratios = model === 'seedance2' ? ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'] : ['16:9', '9:16', '1:1'];
  if (durationSeconds < minDuration || durationSeconds > 15) throw new Error(`${model} durationSeconds must be between ${minDuration} and 15`);
  if (!ratios.includes(ratio)) throw new Error(`${model} does not support ratio ${ratio}`);
  if (input.lastFramePath && !input.firstFramePath) throw new Error('lastFrame requires firstFrame');
  if (model === 'seedance2') {
    if (input.resolution && input.resolution !== '720p') throw new Error('seedance2 currently supports 720p only');
    if (input.lastFramePath && (refImagePaths.length || refVideoPaths.length || refAudioPaths.length)) throw new Error('seedance2 lastFrame mode cannot be combined with references');
    if (refImagePaths.length > 9 || refVideoPaths.length > 3 || refAudioPaths.length > 3) throw new Error('seedance2 reference limit exceeded');
    if (refAudioPaths.length && !input.firstFramePath && !refImagePaths.length && !refVideoPaths.length) throw new Error('seedance2 audio references require a visual reference');
    if (input.shotType || input.multiPrompts?.length) throw new Error('multi-shot parameters are supported by kling only');
  } else {
    if (refVideoPaths.length || refAudioPaths.length) throw new Error('kling currently supports project image references only; refVideos and refAudios are not supported');
    if (input.mode && input.resolution && (input.mode === 'pro') !== (input.resolution === '1080p')) throw new Error('kling mode and resolution conflict');
    if ((input.firstFramePath ? 1 : 0) + (input.lastFramePath ? 1 : 0) + refImagePaths.length > 7) throw new Error('kling accepts at most 7 images');
    if (input.shotType === 'customize') {
      if (prompt) throw new Error('omit prompt for kling customize; use multiPrompts');
      const shots = input.multiPrompts ?? [];
      if (shots.length < 2 || shots.length > 6) throw new Error('kling customize requires 2 to 6 multiPrompts');
      let total = 0;
      for (let index = 0; index < shots.length; index += 1) {
        const shot = shots[index];
        const duration = seconds(shot.duration, 0);
        if (shot.index !== index + 1) throw new Error('kling multiPrompt indexes must be consecutive from 1');
        if (!shot.prompt?.trim() || shot.prompt.length > 512) throw new Error('each kling multiPrompt requires a prompt of at most 512 characters');
        if (duration < 1) throw new Error('each kling multiPrompt duration must be at least 1 second');
        total += duration;
      }
      if (total !== durationSeconds) throw new Error('kling multiPrompt durations must sum to durationSeconds');
    } else {
      if (input.multiPrompts?.length) throw new Error('kling multiPrompts require shotType=customize');
      if (!prompt) throw new Error('prompt is required');
    }
    if (prompt.length > 2500) throw new Error('kling prompt must be at most 2500 characters');
  }
  if (model === 'seedance2' && !prompt) throw new Error('prompt is required');
  return { ...input, model, prompt, durationSeconds, ratio, refImagePaths, refVideoPaths, refAudioPaths };
}

function mimeFor(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.wav') return 'audio/wav';
  if (extension === '.mp4') return 'video/mp4';
  if (extension === '.webm') return 'video/webm';
  if (extension === '.mp3') return 'audio/mpeg';
  return 'image/jpeg';
}

async function mediaDataUrl(path: string): Promise<string> {
  const clean = path.split(/[?#]/, 1)[0];
  if (!clean.startsWith('/media/uploads/')) throw new Error(`provider reference must be a project upload: ${path}`);
  const file = resolve(process.cwd(), 'public', clean.slice(1));
  if (!file.startsWith(`${UPLOAD_DIR}/`)) throw new Error('invalid project media path');
  const bytes = await readFile(file);
  return `data:${mimeFor(file)};base64,${bytes.toString('base64')}`;
}

async function requestJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(await providerError(response));
  const data = await response.json() as Record<string, unknown>;
  if (typeof data.code === 'number' && data.code !== 0) throw new Error(String(data.message ?? `video provider failed (${data.code})`));
  return data;
}

const wait = (milliseconds: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function generateSeedance(input: ValidVideoRequest, options: VideoOptions): Promise<string> {
  if (!options.seedanceApiKey) throw new Error('Seedance generation is not configured. Set SEEDANCE_API_KEY in .env.local.');
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: input.prompt }];
  if (input.firstFramePath) content.push({ type: 'image_url', image_url: { url: await mediaDataUrl(input.firstFramePath) }, role: 'first_frame' });
  if (input.lastFramePath) content.push({ type: 'image_url', image_url: { url: await mediaDataUrl(input.lastFramePath) }, role: 'last_frame' });
  for (const path of input.refImagePaths) content.push({ type: 'image_url', image_url: { url: await mediaDataUrl(path) }, role: 'reference_image' });
  for (const path of input.refVideoPaths) content.push({ type: 'video_url', video_url: { url: await mediaDataUrl(path) }, role: 'reference_video' });
  for (const path of input.refAudioPaths) content.push({ type: 'audio_url', audio_url: { url: await mediaDataUrl(path) }, role: 'reference_audio' });
  const baseUrl = options.seedanceBaseUrl.replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${options.seedanceApiKey}`, 'Content-Type': 'application/json' };
  const task = await requestJson(`${baseUrl}/contents/generations/tasks`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: options.seedanceModel, content, generate_audio: true, ratio: input.firstFramePath || input.lastFramePath ? 'adaptive' : input.ratio, duration: input.durationSeconds, watermark: false }),
  });
  const taskId = String(task.id ?? '');
  if (!taskId) throw new Error('seedance2 did not return a task id');
  const deadline = Date.now() + 10 * 60_000;
  let current = task;
  while (Date.now() < deadline) {
    const status = String(current.status ?? '');
    if (status === 'succeeded') {
      const result = current.content as { video_url?: string } | undefined;
      if (!result?.video_url) throw new Error('seedance2 succeeded without a video URL');
      return result.video_url;
    }
    if (VIDEO_FAILURES.has(status)) throw new Error(String((current.error as { message?: string } | undefined)?.message ?? `seedance2 generation ${status}`));
    await wait(2_000);
    current = await requestJson(`${baseUrl}/contents/generations/tasks/${encodeURIComponent(taskId)}`, { headers });
  }
  throw new Error('seedance2 generation timed out');
}

function klingPrompt(prompt: string): string {
  return prompt.replace(/@(Image|图片)(\d+)/gi, '<<<image_$2>>>');
}

async function generateKling(input: ValidVideoRequest, options: VideoOptions): Promise<string> {
  if (!options.klingApiKey) throw new Error('Kling generation is not configured. Set KLING_API_KEY in .env.local.');
  const imageList: Array<{ image_url: string; type?: 'first_frame' | 'end_frame' }> = [];
  if (input.firstFramePath) imageList.push({ image_url: await mediaDataUrl(input.firstFramePath), type: 'first_frame' });
  if (input.lastFramePath) imageList.push({ image_url: await mediaDataUrl(input.lastFramePath), type: 'end_frame' });
  for (const path of input.refImagePaths) imageList.push({ image_url: await mediaDataUrl(path) });
  const mode = input.mode ?? (input.resolution === '1080p' ? 'pro' : 'std');
  const body: Record<string, unknown> = {
    model_name: options.klingModel,
    prompt: input.shotType === 'customize' ? '' : klingPrompt(input.prompt),
    mode,
    aspect_ratio: input.ratio,
    duration: String(input.durationSeconds),
  };
  if (imageList.length) body.image_list = imageList;
  if (input.shotType) {
    body.multi_shot = true;
    body.shot_type = input.shotType;
  }
  if (input.shotType === 'customize') {
    body.multi_prompt = input.multiPrompts!.map((shot) => ({ index: shot.index, prompt: klingPrompt(shot.prompt), duration: String(seconds(shot.duration, 0)) }));
  }
  const baseUrl = options.klingBaseUrl.replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${options.klingApiKey}`, 'Content-Type': 'application/json' };
  const task = await requestJson(`${baseUrl}/v1/videos/omni-video`, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = task.data as Record<string, unknown> | undefined;
  const taskId = String(data?.task_id ?? '');
  if (!taskId) throw new Error('kling did not return a task id');
  const deadline = Date.now() + 10 * 60_000;
  let current = task;
  while (Date.now() < deadline) {
    const currentData = current.data as Record<string, unknown> | undefined;
    const status = String(currentData?.task_status ?? currentData?.status ?? '');
    if (status === 'succeed' || status === 'succeeded') {
      const taskResult = currentData?.task_result as { videos?: Array<{ url?: string }> } | undefined;
      const url = taskResult?.videos?.[0]?.url;
      if (!url) throw new Error('kling succeeded without a video URL');
      return url;
    }
    if (VIDEO_FAILURES.has(status)) throw new Error(String(currentData?.task_status_msg ?? `kling generation ${status}`));
    await wait(2_000);
    current = await requestJson(`${baseUrl}/v1/videos/omni-video/${encodeURIComponent(taskId)}`, { headers });
  }
  throw new Error('kling generation timed out');
}

interface MinimaxBaseResp { status_code?: number; status_msg?: string }

/** MiniMax request: HTTP errors AND in-band base_resp errors both throw; the raw body
 * text is kept alongside the parsed JSON so int64 fields can be re-read as strings. */
async function minimaxJson(url: string, init: RequestInit): Promise<{ raw: string; data: Record<string, unknown> }> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(await providerError(response));
  const raw = await response.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`hailuo returned invalid JSON: ${raw.slice(0, 200)}`);
  }
  const base = data.base_resp as MinimaxBaseResp | undefined;
  if (base && base.status_code !== 0) throw new Error(base.status_msg || `hailuo provider failed (${base.status_code})`);
  return { raw, data };
}

/** file_id is an int64 — read it from the raw response TEXT as a string; JSON.parse
 * would round it through a JS double and corrupt the id. */
function hailuoFileId(raw: string): string {
  const match = /"file_id"\s*:\s*"?(\d+)"?/.exec(raw);
  if (!match) throw new Error('hailuo succeeded without a file_id');
  return match[1];
}

async function generateHailuo(input: ValidVideoRequest, options: VideoOptions): Promise<string> {
  if (!options.minimaxApiKey) throw new Error('MiniMax is not configured. Set MINIMAX_API_KEY in .env.local or 设置面板.');
  const baseUrl = options.minimaxBaseUrl.replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${options.minimaxApiKey}`, 'Content-Type': 'application/json' };
  const body: Record<string, unknown> = {
    model: options.minimaxModel,
    prompt: input.prompt,
    duration: input.durationSeconds,
    resolution: input.resolution === '1080p' ? '1080P' : '720P',
    prompt_optimizer: true,
  };
  if (input.firstFramePath) body.first_frame_image = await mediaDataUrl(input.firstFramePath);
  const submit = await minimaxJson(`${baseUrl}/v1/video_generation`, { method: 'POST', headers, body: JSON.stringify(body) });
  const taskId = String(submit.data.task_id ?? '');
  if (!taskId) throw new Error('hailuo did not return a task id');
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await wait(10_000);  // documented MiniMax polling interval
    const poll = await minimaxJson(`${baseUrl}/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`, { headers });
    const status = String(poll.data.status ?? '');
    if (status === 'Success') {
      const retrieve = await minimaxJson(`${baseUrl}/v1/files/retrieve?file_id=${encodeURIComponent(hailuoFileId(poll.raw))}`, { headers });
      const file = retrieve.data.file as { download_url?: string } | undefined;
      if (!file?.download_url) throw new Error('hailuo succeeded without a download URL');
      return file.download_url;
    }
    if (status === 'Fail') throw new Error('hailuo generation failed');
  }
  throw new Error('hailuo generation timed out');
}

async function probeVideo(file: string): Promise<{ durationSeconds: number; width?: number; height?: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file]);
    let output = '';
    child.stdout.on('data', (data) => { output += String(data); });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        const parsed = JSON.parse(output) as { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
        const durationSeconds = Number(parsed.format?.duration);
        if (code !== 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error();
        resolvePromise({ durationSeconds, width: parsed.streams?.[0]?.width, height: parsed.streams?.[0]?.height });
      } catch {
        reject(new Error('unable to probe generated video'));
      }
    });
  });
}

async function saveVideo(url: string): Promise<{ path: string; durationSeconds: number; width?: number; height?: number }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(await providerError(response));
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error('video provider returned empty video');
  await mkdir(UPLOAD_DIR, { recursive: true });
  const filename = `${randomUUID()}.mp4`;
  const file = join(UPLOAD_DIR, filename);
  await writeFile(file, bytes);
  return { path: `/media/uploads/${filename}`, ...await probeVideo(file) };
}

export function videoGenerationPlugin(options: VideoOptions): Plugin {
  return {
    name: 'chatcut-video-generation',
    configureServer(server) {
      server.middlewares.use('/generate/video', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed — use POST' }); return; }
        try {
          const input = validate(await readJson(req));
          const name = String(input.name ?? '').trim() || `Video · ${(input.prompt || input.multiPrompts?.[0]?.prompt || input.model).slice(0, 36)}`;
          const submission = createGenerationJob({
            kind: 'video', model: input.model, name, prompt: input.prompt,
            durationSeconds: input.durationSeconds, ratio: input.ratio,
          }, async (jobId): Promise<GenerationResult> => {
            const url = input.model === 'seedance2' ? await generateSeedance(input, options)
              : input.model === 'kling' ? await generateKling(input, options)
              : await generateHailuo(input, options);
            const saved = await saveVideo(url);
            return { assetId: jobId, kind: 'video', name, ...saved };
          });
          sendJson(res, 202, submission);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[generate:video] ${message}`);
          sendJson(res, 400, { error: message });
        }
      });
    },
  };
}
