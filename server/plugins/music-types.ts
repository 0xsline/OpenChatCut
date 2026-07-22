export type MusicProvider = 'mureka' | 'minimax';
export type MusicMode = 'instrumental' | 'song' | 'prompt-song' | 'soundtrack' | 'track' | 't2m' | 'cover';
export type MusicAudioFormat = 'mp3' | 'wav' | 'pcm' | 'flac';
export type MurekaStyle = 'pop' | 'rock' | 'jazz' | 'r&b' | 'edm' | 'ambient' | 'folk'
  | 'latin' | 'k-pop' | 'j-pop' | 'house' | 'gospel' | 'lo-fi';
export type MurekaTrackType = 'Vocals' | 'Instrumental' | 'Drums' | 'Bass' | 'Guitar'
  | 'Keyboard' | 'Percussion' | 'Strings' | 'Synth' | 'FX' | 'Brass' | 'Woodwinds';

export interface MusicOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  minimaxBaseUrl: string;
  minimaxApiKey: string;
  minimaxModel: string;
}

export interface MusicRequest {
  prompt?: string;
  name?: string;
  provider?: string;
  mode?: MusicMode;
  lyrics?: string;
  isInstrumental?: boolean;
  lyricsOptimizer?: boolean;
  sampleRate?: number;
  bitrate?: number;
  audioFormat?: MusicAudioFormat;
  referenceAudioPath?: string;
  coverFeatureId?: string;
  count?: number;
  stream?: boolean;
  styles?: MurekaStyle[];
  gender?: 'female' | 'male';
  referenceId?: string;
  instrumentalId?: string;
  vocalId?: string;
  melodyId?: string;
  sourceAssetPath?: string;
  sourceAssetKind?: 'audio' | 'image' | 'video';
  audioStartMs?: number;
  audioEndMs?: number;
  songId?: string;
  trackType?: MurekaTrackType;
  generateStartMs?: number;
  generateEndMs?: number;
  vocalGender?: 'female' | 'male';
}

export interface ValidMusicRequest extends MusicRequest {
  provider: MusicProvider;
  mode: MusicMode;
  prompt: string;
  name: string;
  isInstrumental: boolean;
  lyricsOptimizer: boolean;
  sampleRate: number;
  bitrate: number;
  audioFormat: MusicAudioFormat;
  count: number;
  stream: boolean;
  coverMode: boolean;
}

export interface MurekaChoice {
  index?: number;
  audio_url?: string;
  url?: string;
  wav_url?: string;
  flac_url?: string;
}

export interface MurekaTask {
  id?: string;
  status?: string;
  failed_reason?: string;
  choices?: MurekaChoice[];
}
