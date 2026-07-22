import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { createGenerationJob, type GenerationResult } from './generation-jobs.ts';
import { mediaDataUrl, providerMediaUrl, saveImageUrl, saveVideo } from './video-media.ts';
import {
  hailuoApiResolution, seedanceApiResolution, validateVideoRequest, videoSeconds,
  type KlingVideoReferType, type ValidVideoRequest, type VideoRequest,
} from './video-validation.ts';
export { hailuoApiResolution, seedanceApiResolution, validateVideoRequest } from './video-validation.ts';
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

const validate = validateVideoRequest;

async function requestJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(await providerError(response));
  const data = await response.json() as Record<string, unknown>;
  if (typeof data.code === 'number' && data.code !== 0) throw new Error(String(data.message ?? `video provider failed (${data.code})`));
  return data;
}

const wait = (milliseconds: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

interface SeedanceResult { videoUrl: string; lastFrameUrl?: string }

export function seedanceRequestBody(
  input: ValidVideoRequest,
  model: string,
  content: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model, content, generate_audio: input.generateAudio ?? true,
    ratio: input.firstFramePath || input.lastFramePath ? 'adaptive' : input.ratio,
    duration: input.durationSeconds, resolution: seedanceApiResolution(input.resolution),
    camera_fixed: input.cameraFixed ?? false, watermark: input.watermark ?? false,
  };
  if (input.seed !== undefined) body.seed = input.seed;
  if (input.returnLastFrame !== undefined) body.return_last_frame = input.returnLastFrame;
  if (input.executionExpiresAfter !== undefined) body.execution_expires_after = input.executionExpiresAfter;
  if (input.priority !== undefined) body.priority = input.priority;
  return body;
}

async function generateSeedance(input: ValidVideoRequest, options: VideoOptions): Promise<SeedanceResult> {
  if (!options.seedanceApiKey) throw new Error('Seedance generation is not configured. Set SEEDANCE_API_KEY in .env.local.');
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: input.prompt }];
  if (input.firstFramePath) content.push({ type: 'image_url', image_url: { url: await mediaDataUrl(input.firstFramePath) }, role: 'first_frame' });
  if (input.lastFramePath) content.push({ type: 'image_url', image_url: { url: await mediaDataUrl(input.lastFramePath) }, role: 'last_frame' });
  for (const path of input.refImagePaths) content.push({ type: 'image_url', image_url: { url: await mediaDataUrl(path) }, role: 'reference_image' });
  for (const path of input.refVideoPaths) content.push({ type: 'video_url', video_url: { url: await providerMediaUrl(path) }, role: 'reference_video' });
  for (const path of input.refAudioPaths) content.push({ type: 'audio_url', audio_url: { url: await mediaDataUrl(path) }, role: 'reference_audio' });
  const baseUrl = options.seedanceBaseUrl.replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${options.seedanceApiKey}`, 'Content-Type': 'application/json' };
  const body = seedanceRequestBody(input, options.seedanceModel, content);
  const task = await requestJson(`${baseUrl}/contents/generations/tasks`, {
    method: 'POST', headers,
    body: JSON.stringify(body),
  });
  const taskId = String(task.id ?? '');
  if (!taskId) throw new Error('seedance2 did not return a task id');
  const deadline = Date.now() + 10 * 60_000;
  let current = task;
  while (Date.now() < deadline) {
    const status = String(current.status ?? '');
    if (status === 'succeeded') {
      const result = current.content as { video_url?: string; last_frame_url?: string } | undefined;
      if (!result?.video_url) throw new Error('seedance2 succeeded without a video URL');
      return { videoUrl: result.video_url, lastFrameUrl: result.last_frame_url };
    }
    if (VIDEO_FAILURES.has(status)) throw new Error(String((current.error as { message?: string } | undefined)?.message ?? `seedance2 generation ${status}`));
    await wait(2_000);
    current = await requestJson(`${baseUrl}/contents/generations/tasks/${encodeURIComponent(taskId)}`, { headers });
  }
  throw new Error('seedance2 generation timed out');
}

/** Map agent @ImageN / @VideoN (and 图片/视频) to Kling Omni <<<image_n>>> / <<<video_n>>> tokens. */
export function klingPrompt(prompt: string): string {
  return prompt
    .replace(/@(Image|图片)(\d+)/gi, '<<<image_$2>>>')
    .replace(/@(Video|视频)(\d+)/gi, '<<<video_$2>>>');
}

async function generateKling(input: ValidVideoRequest, options: VideoOptions): Promise<string> {
  if (!options.klingApiKey) throw new Error('Kling generation is not configured. Set KLING_API_KEY in .env.local.');
  const imageList: Array<{ image_url: string; type?: 'first_frame' | 'end_frame' }> = [];
  if (input.firstFramePath) imageList.push({ image_url: await mediaDataUrl(input.firstFramePath), type: 'first_frame' });
  if (input.lastFramePath) imageList.push({ image_url: await mediaDataUrl(input.lastFramePath), type: 'end_frame' });
  for (const path of input.refImagePaths) imageList.push({ image_url: await mediaDataUrl(path) });
  // Omni video ref: feature (motion/camera/style) or base (edit source). At most one.
  const referType: KlingVideoReferType = input.refVideoMode === 'base' ? 'base' : 'feature';
  const videoList: Array<{ video_url: string; refer_type: KlingVideoReferType; keep_original_sound?: string }> = [];
  for (const path of input.refVideoPaths) {
    videoList.push({
      video_url: await mediaDataUrl(path),
      refer_type: referType,
      // Base edit: keep source audio by default so dialogue/SFX survive when possible.
      ...(referType === 'base' ? { keep_original_sound: 'yes' } : {}),
    });
  }
  const mode = input.mode ?? (input.resolution === '1080p' ? 'pro' : 'std');
  const body: Record<string, unknown> = {
    model_name: options.klingModel,
    prompt: input.shotType === 'customize' ? '' : klingPrompt(input.prompt),
    mode,
    aspect_ratio: input.ratio,
    duration: String(input.durationSeconds),
  };
  if (imageList.length) body.image_list = imageList;
  if (videoList.length) body.video_list = videoList;
  if (input.shotType) {
    body.multi_shot = true;
    body.shot_type = input.shotType;
  }
  if (input.shotType === 'customize') {
    body.multi_prompt = input.multiPrompts!.map((shot) => ({ index: shot.index, prompt: klingPrompt(shot.prompt), duration: String(videoSeconds(shot.duration, 0)) }));
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

/** MiniMax S2V-01 subject-reference path (face/subject lock). Configured via MINIMAX_VIDEO_MODEL. */
export function isMinimaxSubjectModel(modelName: string): boolean {
  return /s2v/i.test(modelName);
}

type MinimaxVideoFamily = 'subject' | 'hailuo02' | 'hailuo23' | 'hailuo23-fast' | 'legacy-t2v' | 'legacy-i2v';

function minimaxVideoFamily(modelName: string): MinimaxVideoFamily {
  if (/^s2v-01$/i.test(modelName)) return 'subject';
  if (/hailuo-2\.3-fast/i.test(modelName)) return 'hailuo23-fast';
  if (/hailuo-2\.3/i.test(modelName)) return 'hailuo23';
  if (/hailuo-02/i.test(modelName)) return 'hailuo02';
  if (/^t2v-01(?:-director)?$/i.test(modelName)) return 'legacy-t2v';
  if (/^i2v-01(?:-director|-live)?$/i.test(modelName)) return 'legacy-i2v';
  throw new Error(`unsupported MiniMax video model: ${modelName}`);
}

export function validateMinimaxVideoMode(input: ValidVideoRequest, modelName: string): MinimaxVideoFamily {
  const family = minimaxVideoFamily(modelName);
  if (family === 'subject') {
    if (!input.firstFramePath) throw new Error('MiniMax S2V subject-reference requires firstFrame (subject/face image)');
    if (input.lastFramePath) throw new Error('MiniMax S2V subject-reference does not support lastFrame');
    if (input.durationSpecified || input.resolution) throw new Error('MiniMax S2V does not accept durationSeconds or resolution');
    if (input.fastPretreatment !== undefined) throw new Error('MiniMax S2V does not accept fastPretreatment');
  }
  if (family === 'hailuo23-fast' && !input.firstFramePath) throw new Error('MiniMax-Hailuo-2.3-Fast is image-to-video only and requires firstFrame');
  if (input.lastFramePath && family !== 'hailuo02') throw new Error('MiniMax first-and-last-frame mode requires MiniMax-Hailuo-02');
  if (input.lastFramePath && input.fastPretreatment !== undefined) throw new Error('MiniMax first-and-last-frame mode does not accept fastPretreatment');
  if (input.resolution === '512p' && family !== 'hailuo02') throw new Error('hailuo 512p requires the MiniMax-Hailuo-02 model');
  const legacy = family === 'legacy-t2v' || family === 'legacy-i2v';
  if (legacy && (input.durationSeconds !== 6 || (input.resolution && input.resolution !== '720p'))) throw new Error('legacy MiniMax video models support 6s at 720p only');
  if (legacy && input.fastPretreatment !== undefined) throw new Error('legacy MiniMax video models do not accept fastPretreatment');
  if (family === 'legacy-t2v' && input.firstFramePath) throw new Error(`${modelName} is text-to-video only`);
  if (family === 'legacy-i2v' && !input.firstFramePath) throw new Error(`${modelName} is image-to-video only and requires firstFrame`);
  return family;
}

export function hailuoRequestBody(
  input: ValidVideoRequest, modelName: string, firstFrameImage?: string, lastFrameImage?: string,
): Record<string, unknown> {
  const family = validateMinimaxVideoMode(input, modelName);
  const body: Record<string, unknown> = { model: modelName, prompt: input.prompt, prompt_optimizer: input.promptOptimizer !== false };
  if (family === 'subject') {
    if (!firstFrameImage) throw new Error('MiniMax S2V firstFrame could not be resolved');
    body.subject_reference = [{ type: 'character', image: [firstFrameImage] }];
    return body;
  }
  if (input.firstFramePath && !firstFrameImage) throw new Error('MiniMax firstFrame could not be resolved');
  if (input.lastFramePath && !lastFrameImage) throw new Error('MiniMax lastFrame could not be resolved');
  body.duration = input.durationSeconds;
  body.resolution = family.startsWith('legacy-') ? '720P' : hailuoApiResolution(input.resolution);
  if (firstFrameImage) body.first_frame_image = firstFrameImage;
  if (lastFrameImage) body.last_frame_image = lastFrameImage;
  if (input.fastPretreatment === true) body.fast_pretreatment = true;
  return body;
}

async function generateHailuo(input: ValidVideoRequest, options: VideoOptions): Promise<string> {
  if (!options.minimaxApiKey) throw new Error('MiniMax is not configured. Set MINIMAX_API_KEY in .env.local or 设置面板.');
  const baseUrl = options.minimaxBaseUrl.replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${options.minimaxApiKey}`, 'Content-Type': 'application/json' };
  const firstFrame = input.firstFramePath ? await mediaDataUrl(input.firstFramePath) : undefined;
  const lastFrame = input.lastFramePath ? await mediaDataUrl(input.lastFramePath) : undefined;
  const body = hailuoRequestBody(input, options.minimaxModel, firstFrame, lastFrame);
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

export function videoGenerationPlugin(options: VideoOptions): Plugin {
  return {
    name: 'openchatcut-video-generation',
    configureServer(server) {
      server.middlewares.use('/generate/video', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed — use POST' }); return; }
        try {
          const input = validate(await readJson(req));
          const name = String(input.name ?? '').trim() || `Video · ${(input.prompt || input.multiPrompts?.[0]?.prompt || input.model).slice(0, 36)}`;
          const submission = createGenerationJob({
            kind: 'video', model: input.model, name, prompt: input.prompt,
            durationSeconds: input.durationSeconds, ratio: input.ratio,
          }, async (jobId): Promise<GenerationResult | GenerationResult[]> => {
            if (input.model === 'seedance2') {
              const generated = await generateSeedance(input, options);
              const video = { assetId: jobId, kind: 'video' as const, name, ...await saveVideo(generated.videoUrl) };
              if (!input.returnLastFrame) return video;
              if (!generated.lastFrameUrl) throw new Error('seedance2 did not return the requested last frame');
              const path = await saveImageUrl(generated.lastFrameUrl);
              return [video, {
                assetId: `${jobId}:last-frame`, kind: 'image', name: `${name} · Last frame`, path,
                durationSeconds: 5,
              }];
            }
            const url = input.model === 'kling'
              ? await generateKling(input, options)
              : await generateHailuo(input, options);
            return { assetId: jobId, kind: 'video', name, ...await saveVideo(url) };
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
