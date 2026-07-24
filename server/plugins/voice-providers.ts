import { randomUUID } from 'node:crypto';

import type { ValidVoiceRequest, VoiceOptions } from './voice-types.ts';

const DOUBAO_VOICES: Record<string, string> = {
  vivi: 'zh_female_vv_uranus_bigtts', xiaohe: 'zh_female_xiaohe_uranus_bigtts', yunzhou: 'zh_male_m191_uranus_bigtts',
  xiaotian: 'zh_male_taocheng_uranus_bigtts', naiqimengwa: 'zh_male_naiqimengwa_uranus_bigtts',
  yingtaowanzi: 'zh_female_yingtaowanzi_uranus_bigtts', wenroumama: 'zh_female_wenroumama_uranus_bigtts',
  zhixingnv: 'zh_female_zhixingnv_uranus_bigtts', dayi: 'zh_male_dayi_uranus_bigtts', jitangnv: 'zh_female_jitangnv_uranus_bigtts',
  liuchang: 'zh_female_liuchangnv_uranus_bigtts', ruyayichen: 'zh_male_ruyayichen_uranus_bigtts',
  morgan: 'zh_male_cixingjieshuonan_uranus_bigtts', qingcang: 'zh_male_qingcang_uranus_bigtts', huiben: 'zh_female_xiaoxue_uranus_bigtts',
  popo: 'zh_female_popo_uranus_bigtts', yuanboxiaoshu: 'zh_male_yuanboxiaoshu_uranus_bigtts',
  baqiqingshu: 'zh_male_baqiqingshu_uranus_bigtts', shuanglangshaonian: 'saturn_zh_male_shuanglangshaonian_tob',
  tangseng: 'zh_male_tangseng_uranus_bigtts',
};

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
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v2/voices?search=${encodeURIComponent(voiceId)}&page_size=100`, {
    headers: { 'xi-api-key': apiKey },
  });
  if (!response.ok) throw new Error(await providerError(response));
  const result = await response.json() as { voices?: Array<{ voice_id?: string; name?: string }> };
  const match = result.voices?.find((voice) => voice.name?.toLowerCase() === voiceId.toLowerCase());
  if (!match?.voice_id) throw new Error(`ElevenLabs voice not found: ${voiceId}`);
  return match.voice_id;
}

export async function elevenLabsVoice(options: VoiceOptions, input: ValidVoiceRequest): Promise<Buffer> {
  if (!options.elevenApiKey) throw new Error('ElevenLabs is not configured. Set ELEVENLABS_API_KEY in .env.local.');
  const voiceId = await resolveElevenVoice(options.elevenBaseUrl, options.elevenApiKey, input.voiceId);
  const query = new URLSearchParams({ output_format: input.outputFormat });
  if (input.optimizeStreamingLatency != null) query.set('optimize_streaming_latency', String(input.optimizeStreamingLatency));
  if (input.enableLogging != null) query.set('enable_logging', String(input.enableLogging));
  const body: Record<string, unknown> = {
    text: input.text, model_id: input.modelId || options.elevenModel, language_code: input.languageCode,
    seed: input.seed, previous_text: input.previousText, next_text: input.nextText,
    previous_request_ids: input.previousRequestIds, next_request_ids: input.nextRequestIds,
    apply_text_normalization: input.applyTextNormalization,
    apply_language_text_normalization: input.applyLanguageTextNormalization,
    pronunciation_dictionary_locators: input.pronunciationDictionaryLocators?.map((item) => ({
      pronunciation_dictionary_id: item.pronunciationDictionaryId, version_id: item.versionId,
    })),
    voice_settings: { stability: input.stability ?? 0.5, similarity_boost: input.similarityBoost,
      style: input.style, use_speaker_boost: input.useSpeakerBoost, speed: input.speed ?? 1 },
  };
  const response = await fetch(`${options.elevenBaseUrl.replace(/\/$/, '')}/v1/text-to-speech/${voiceId}?${query}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'xi-api-key': options.elevenApiKey }, body: JSON.stringify(body),
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

export async function doubaoVoice(options: VoiceOptions, input: ValidVoiceRequest): Promise<Buffer> {
  if (!options.doubaoAppId || !options.doubaoAccessKey) throw new Error('Doubao is not configured. Set DOUBAO_TTS_APP_ID and DOUBAO_TTS_ACCESS_KEY.');
  const audioParams = { format: 'mp3', sample_rate: 24_000,
    speech_rate: Math.round(((input.speedRatio ?? 1) - 1) * 100), loudness_rate: Math.round(((input.loudnessRatio ?? 1) - 1) * 100) };
  const reqParams: Record<string, unknown> = { text: input.text, speaker: DOUBAO_VOICES[input.voiceId] ?? input.voiceId, audio_params: audioParams };
  if (input.emotion) reqParams.emotion = input.emotion;
  if (input.emotionScale != null) reqParams.emotion_scale = input.emotionScale;
  if (input.performancePrompt) reqParams.voice_instruction = input.performancePrompt;
  if (input.explicitDialect) reqParams.explicit_dialect = input.explicitDialect;
  const response = await fetch(`${options.doubaoBaseUrl.replace(/\/$/, '')}/api/v3/tts/unidirectional`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-App-Id': options.doubaoAppId,
      'X-Api-Access-Key': options.doubaoAccessKey, 'X-Api-Resource-Id': options.doubaoResourceId },
    body: JSON.stringify({ user: { uid: `openchatcut-${randomUUID()}` }, req_params: reqParams }),
  });
  if (!response.ok) throw new Error(await providerError(response));
  return doubaoAudio(await response.text());
}

interface MinimaxTtsResponse {
  data?: { audio?: string; subtitle_file?: string; status?: number };
  base_resp?: { status_code?: number; status_msg?: string };
}

export interface MinimaxVoiceResult { audio: Buffer; subtitleUrl?: string }

function minimaxChunks(text: string): MinimaxTtsResponse[] {
  try {
    const parsed = JSON.parse(text) as MinimaxTtsResponse | MinimaxTtsResponse[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const chunks: MinimaxTtsResponse[] = [];
    for (const line of text.split(/\r?\n/)) {
      const payload = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
      if (!payload || payload === '[DONE]') continue;
      try { chunks.push(JSON.parse(payload) as MinimaxTtsResponse); } catch { /* SSE comments / event fields */ }
    }
    if (!chunks.length) throw new Error(`MiniMax returned invalid TTS data: ${text.slice(0, 200)}`);
    return chunks;
  }
}

export function minimaxVoiceResult(text: string, stream: boolean, excludeAggregatedAudio: boolean): MinimaxVoiceResult {
  const chunks = minimaxChunks(text);
  for (const chunk of chunks) {
    if (chunk.base_resp && chunk.base_resp.status_code !== 0) {
      throw new Error(chunk.base_resp.status_msg || `MiniMax TTS failed (${chunk.base_resp.status_code})`);
    }
  }
  const subtitleUrl = chunks.find((chunk) => chunk.data?.subtitle_file)?.data?.subtitle_file;
  const final = chunks.find((chunk) => chunk.data?.status === 2 && chunk.data.audio)?.data?.audio;
  const pieces = chunks.filter((chunk) => chunk.data?.status === 1 && chunk.data.audio).map((chunk) => Buffer.from(chunk.data!.audio!, 'hex'));
  const audio = stream && excludeAggregatedAudio && pieces.length ? Buffer.concat(pieces) : Buffer.from(final ?? chunks[0]?.data?.audio ?? '', 'hex');
  if (!audio.length) throw new Error('MiniMax returned no audio');
  return { audio, subtitleUrl };
}

function validateMinimaxModelOptions(model: string, input: ValidVoiceRequest): void {
  if (/speech-(?:01|02)-/i.test(model) && ['Persian', 'Filipino', 'Tamil'].includes(input.languageBoost ?? '')) {
    throw new Error(`${model} does not support languageBoost=${input.languageBoost}`);
  }
  if (/speech-2\.8-/i.test(model) && input.emotion === 'whisper') throw new Error(`${model} does not support emotion=whisper`);
}

export function minimaxVoiceBody(model: string, input: ValidVoiceRequest): Record<string, unknown> {
  validateMinimaxModelOptions(model, input);
  const audioSetting: Record<string, unknown> = { sample_rate: input.sampleRate, format: input.audioFormat, channel: input.channel };
  if (input.bitrate !== undefined) audioSetting.bitrate = input.bitrate;
  if (input.forceCbr === true) audioSetting.force_cbr = true;
  return {
    model, text: input.text, stream: input.stream ?? false, output_format: 'hex',
    stream_options: input.stream ? { exclude_aggregated_audio: input.excludeAggregatedAudio ?? false } : undefined,
    voice_setting: { voice_id: input.voiceId, speed: input.speed ?? 1, vol: input.volume ?? 1,
      pitch: input.pitch ?? 0, ...(input.emotion ? { emotion: input.emotion } : {}),
      text_normalization: input.textNormalization, latex_read: input.latexRead },
    audio_setting: audioSetting,
    language_boost: input.latexRead ? 'Chinese' : input.languageBoost,
    pronunciation_dict: input.pronunciations ? { tone: input.pronunciations } : undefined,
    timbre_weights: input.timbreWeights?.map((item) => ({ voice_id: item.voiceId, weight: item.weight })),
    voice_modify: input.voiceModify ? { pitch: input.voiceModify.pitch, intensity: input.voiceModify.intensity,
      timbre: input.voiceModify.timbre, sound_effects: input.voiceModify.effect } : undefined,
    subtitle_enable: input.subtitleEnable, subtitle_type: input.subtitleType,
  };
}

export async function minimaxVoice(options: VoiceOptions, input: ValidVoiceRequest): Promise<MinimaxVoiceResult> {
  if (!options.minimaxApiKey) throw new Error('MiniMax is not configured. Set MINIMAX_API_KEY in .env.local or settings panel.');
  const body = minimaxVoiceBody(options.minimaxModel, input);
  const response = await fetch(`${options.minimaxBaseUrl.replace(/\/$/, '')}/v1/t2a_v2`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.minimaxApiKey}` }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await providerError(response));
  return minimaxVoiceResult(await response.text(), input.stream === true, input.excludeAggregatedAudio === true);
}
