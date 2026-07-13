import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

const UPLOAD_DIR = resolve(process.cwd(), 'public/media/uploads');

const DOUBAO_VOICES: Record<string, string> = {
  vivi: 'zh_female_vv_uranus_bigtts', xiaohe: 'zh_female_xiaohe_uranus_bigtts',
  yunzhou: 'zh_male_m191_uranus_bigtts', xiaotian: 'zh_male_taocheng_uranus_bigtts',
  naiqimengwa: 'zh_male_naiqimengwa_uranus_bigtts', yingtaowanzi: 'zh_female_yingtaowanzi_uranus_bigtts',
  wenroumama: 'zh_female_wenroumama_uranus_bigtts', zhixingnv: 'zh_female_zhixingnv_uranus_bigtts',
  dayi: 'zh_male_dayi_uranus_bigtts', jitangnv: 'zh_female_jitangnv_uranus_bigtts',
  liuchang: 'zh_female_liuchangnv_uranus_bigtts', ruyayichen: 'zh_male_ruyayichen_uranus_bigtts',
  morgan: 'zh_male_cixingjieshuonan_uranus_bigtts', qingcang: 'zh_male_qingcang_uranus_bigtts',
  huiben: 'zh_female_xiaoxue_uranus_bigtts', popo: 'zh_female_popo_uranus_bigtts',
  yuanboxiaoshu: 'zh_male_yuanboxiaoshu_uranus_bigtts', baqiqingshu: 'zh_male_baqiqingshu_uranus_bigtts',
  shuanglangshaonian: 'saturn_zh_male_shuanglangshaonian_tob', tangseng: 'zh_male_tangseng_uranus_bigtts',
};

interface VoiceOptions {
  elevenBaseUrl: string;
  elevenApiKey: string;
  elevenModel: string;
  doubaoBaseUrl: string;
  doubaoAppId: string;
  doubaoAccessKey: string;
  doubaoResourceId: string;
}

interface VoiceRequest {
  provider?: string;
  text?: string;
  voiceId?: string;
  modelId?: string;
  stability?: number;
  speed?: number;
  speedRatio?: number;
  emotion?: string;
  emotionScale?: number;
  loudnessRatio?: number;
  pitch?: number;
  performancePrompt?: string;
  explicitDialect?: string;
}

async function readJson(req: IncomingMessage): Promise<VoiceRequest> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > 1_000_000) throw new Error('request body too large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as VoiceRequest;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function providerError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const data = JSON.parse(text) as { detail?: { message?: string }; error?: { message?: string }; message?: string };
    return data.detail?.message ?? data.error?.message ?? data.message ?? `voice provider failed (${response.status})`;
  } catch {
    return text.slice(0, 300) || `voice provider failed (${response.status})`;
  }
}

async function resolveElevenVoice(baseUrl: string, apiKey: string, voiceId: string): Promise<string> {
  if (/^[A-Za-z0-9]{15,}$/.test(voiceId)) return voiceId;
  const url = `${baseUrl.replace(/\/$/, '')}/v2/voices?search=${encodeURIComponent(voiceId)}&page_size=100`;
  const response = await fetch(url, { headers: { 'xi-api-key': apiKey } });
  if (!response.ok) throw new Error(await providerError(response));
  const result = await response.json() as { voices?: Array<{ voice_id?: string; name?: string }> };
  const match = result.voices?.find((voice) => voice.name?.toLowerCase() === voiceId.toLowerCase());
  if (!match?.voice_id) throw new Error(`ElevenLabs voice not found: ${voiceId}`);
  return match.voice_id;
}

async function elevenLabs(options: VoiceOptions, input: VoiceRequest & { text: string; voiceId: string }): Promise<Buffer> {
  if (!options.elevenApiKey) throw new Error('ElevenLabs is not configured. Set ELEVENLABS_API_KEY in .env.local.');
  const voiceId = await resolveElevenVoice(options.elevenBaseUrl, options.elevenApiKey, input.voiceId);
  const response = await fetch(`${options.elevenBaseUrl.replace(/\/$/, '')}/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': options.elevenApiKey },
    body: JSON.stringify({
      text: input.text,
      model_id: input.modelId || options.elevenModel,
      voice_settings: { stability: input.stability ?? 0.5, speed: input.speed ?? 1 },
    }),
  });
  if (!response.ok) throw new Error(await providerError(response));
  return Buffer.from(await response.arrayBuffer());
}

function doubaoAudio(text: string): Buffer {
  const parts: Buffer[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const item = JSON.parse(line) as { code?: number; data?: string; message?: string };
    if (item.code && item.code !== 0) throw new Error(item.message ?? `Doubao failed (${item.code})`);
    if (item.data) parts.push(Buffer.from(item.data, 'base64'));
  }
  if (!parts.length) throw new Error('Doubao returned no audio');
  return Buffer.concat(parts);
}

async function doubao(options: VoiceOptions, input: VoiceRequest & { text: string; voiceId: string }): Promise<Buffer> {
  if (!options.doubaoAppId || !options.doubaoAccessKey) throw new Error('Doubao is not configured. Set DOUBAO_TTS_APP_ID and DOUBAO_TTS_ACCESS_KEY in .env.local.');
  const speaker = DOUBAO_VOICES[input.voiceId] ?? input.voiceId;
  const audioParams: Record<string, number | string> = {
    format: 'mp3', sample_rate: 24_000,
    speech_rate: Math.round(((input.speedRatio ?? 1) - 1) * 100),
    loudness_rate: Math.round(((input.loudnessRatio ?? 1) - 1) * 100),
  };
  const reqParams: Record<string, unknown> = { text: input.text, speaker, audio_params: audioParams };
  if (input.emotion) reqParams.emotion = input.emotion;
  if (input.emotionScale != null) reqParams.emotion_scale = input.emotionScale;
  if (input.performancePrompt) reqParams.voice_instruction = input.performancePrompt;
  if (input.explicitDialect) reqParams.explicit_dialect = input.explicitDialect;
  const response = await fetch(`${options.doubaoBaseUrl.replace(/\/$/, '')}/api/v3/tts/unidirectional`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-App-Id': options.doubaoAppId,
      'X-Api-Access-Key': options.doubaoAccessKey,
      'X-Api-Resource-Id': options.doubaoResourceId,
    },
    body: JSON.stringify({ user: { uid: `chatcut-${randomUUID()}` }, req_params: reqParams }),
  });
  if (!response.ok) throw new Error(await providerError(response));
  return doubaoAudio(await response.text());
}

async function pitchShift(file: string, semitones: number): Promise<void> {
  if (!semitones) return;
  const factor = 2 ** (semitones / 12);
  const output = `${file}.pitched.mp3`;
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('ffmpeg', ['-y', '-i', file, '-af', `asetrate=24000*${factor},aresample=24000,atempo=${1 / factor}`, output]);
    let error = '';
    child.stderr.on('data', (data) => { error += String(data); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolvePromise() : reject(new Error(error.slice(-500))));
  });
  await unlink(file);
  await rename(output, file);
}

async function probeDuration(file: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
    let output = '';
    let error = '';
    child.stdout.on('data', (data) => { output += String(data); });
    child.stderr.on('data', (data) => { error += String(data); });
    child.on('error', reject);
    child.on('close', (code) => {
      const duration = Number(output.trim());
      if (code === 0 && Number.isFinite(duration) && duration > 0) resolvePromise(duration);
      else reject(new Error(error || 'unable to probe generated audio'));
    });
  });
}

async function saveAudio(bytes: Buffer, pitch: number): Promise<{ path: string; durationSeconds: number }> {
  if (!bytes.length) throw new Error('voice provider returned empty audio');
  await mkdir(UPLOAD_DIR, { recursive: true });
  const filename = `${randomUUID()}.mp3`;
  const file = join(UPLOAD_DIR, filename);
  await writeFile(file, bytes);
  await pitchShift(file, pitch);
  return { path: `/media/uploads/${filename}`, durationSeconds: await probeDuration(file) };
}

function validate(input: VoiceRequest): VoiceRequest & { provider: 'elevenlabs' | 'doubao'; text: string; voiceId: string } {
  if (input.provider !== 'elevenlabs' && input.provider !== 'doubao') throw new Error('provider must be elevenlabs or doubao');
  const text = String(input.text ?? '').trim();
  const voiceId = String(input.voiceId ?? '').trim();
  if (!text) throw new Error('text is required');
  if (!voiceId) throw new Error('voiceId is required');
  const ranges: Array<[number | undefined, number, number, string]> = [
    [input.stability, 0, 1, 'stability'], [input.speed, 0.7, 1.2, 'speed'],
    [input.speedRatio, 0.5, 2, 'speedRatio'], [input.emotionScale, 1, 5, 'emotionScale'],
    [input.loudnessRatio, 0.5, 2, 'loudnessRatio'], [input.pitch, -12, 12, 'pitch'],
  ];
  for (const [value, min, max, name] of ranges) {
    if (value != null && (!Number.isFinite(value) || value < min || value > max)) throw new Error(`${name} must be between ${min} and ${max}`);
  }
  if (input.performancePrompt && input.performancePrompt.length > 200) throw new Error('performancePrompt must be 200 characters or fewer');
  if (input.emotionScale != null && !input.emotion) throw new Error('emotionScale requires emotion');
  if (input.explicitDialect && voiceId !== 'vivi') throw new Error('explicitDialect is only supported by the Vivi preset');
  if (input.provider === 'elevenlabs') {
    const doubaoFields = [input.speedRatio, input.emotion, input.emotionScale, input.loudnessRatio, input.pitch, input.performancePrompt, input.explicitDialect];
    if (doubaoFields.some((value) => value != null)) throw new Error('ElevenLabs does not accept Doubao-only voice parameters');
  } else {
    const elevenFields = [input.modelId, input.stability, input.speed];
    if (elevenFields.some((value) => value != null)) throw new Error('Doubao does not accept ElevenLabs-only voice parameters');
  }
  return { ...input, provider: input.provider, text, voiceId };
}

export function voiceGenerationPlugin(options: VoiceOptions): Plugin {
  return {
    name: 'chatcut-voice-generation',
    configureServer(server) {
      server.middlewares.use('/generate/voice', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed — use POST' }); return; }
        try {
          const input = validate(await readJson(req));
          const bytes = input.provider === 'elevenlabs' ? await elevenLabs(options, input) : await doubao(options, input);
          sendJson(res, 200, await saveAudio(bytes, input.provider === 'doubao' ? input.pitch ?? 0 : 0));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[generate:voice] ${message}`);
          sendJson(res, 400, { error: message });
        }
      });
    },
  };
}
