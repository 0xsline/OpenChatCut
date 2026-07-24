import { musicProviderError, referenceAudioBase64 } from './music-media.ts';
import type { MusicOptions, ValidMusicRequest } from './music-types.ts';

interface MinimaxMusicResponse {
  data?: { audio?: string };
  base_resp?: { status_code?: number; status_msg?: string };
}

export function isMinimaxCoverModel(modelName: string): boolean {
  return /music-cover/i.test(modelName);
}

export async function minimaxMusicUrl(options: MusicOptions, input: ValidMusicRequest): Promise<string> {
  if (input.coverMode !== isMinimaxCoverModel(options.minimaxModel)) {
    throw new Error(input.coverMode
      ? 'music-cover requires a music-cover model in Settings → live music'
      : 'music-cover model requires mode=cover and referenceAssetId or coverFeatureId');
  }
  const body: Record<string, unknown> = {
    model: options.minimaxModel,
    prompt: input.prompt,
    stream: false,
    output_format: 'url',
    audio_setting: { sample_rate: input.sampleRate, bitrate: input.bitrate, format: input.audioFormat },
  };
  if (input.coverMode) await addCoverInput(body, input);
  else {
    body.is_instrumental = input.isInstrumental;
    if (input.lyrics) body.lyrics = input.lyrics;
    if (input.lyricsOptimizer) body.lyrics_optimizer = true;
  }
  const response = await fetch(`${options.minimaxBaseUrl.replace(/\/$/, '')}/v1/music_generation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.minimaxApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await musicProviderError(response));
  const result = await response.json() as MinimaxMusicResponse;
  if (result.base_resp && result.base_resp.status_code !== 0) {
    throw new Error(result.base_resp.status_msg || `MiniMax music failed (${result.base_resp.status_code})`);
  }
  if (!result.data?.audio) throw new Error('MiniMax returned no audio');
  return result.data.audio;
}

async function addCoverInput(body: Record<string, unknown>, input: ValidMusicRequest): Promise<void> {
  if (input.referenceAudioPath) body.audio_base64 = await referenceAudioBase64(input.referenceAudioPath);
  else if (input.coverFeatureId) body.cover_feature_id = input.coverFeatureId;
  if (input.lyrics) body.lyrics = input.lyrics;
}
