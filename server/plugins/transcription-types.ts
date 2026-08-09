export const CLOUD_TRANSCRIPTION_PROVIDERS = [
  'openai',
  'mistral',
  'deepgram',
  'groq',
  'elevenlabs',
  'cartesia',
] as const;

export type CloudTranscriptionProvider = (typeof CLOUD_TRANSCRIPTION_PROVIDERS)[number];

export interface TranscriptionOptions {
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  mistralBaseUrl: string;
  mistralApiKey: string;
  mistralModel: string;
  deepgramApiKey: string;
  deepgramModel: string;
  groqBaseUrl: string;
  groqApiKey: string;
  groqModel: string;
  elevenApiKey: string;
  elevenModel: string;
  cartesiaApiKey: string;
  cartesiaModel: string;
  language: string;
  diarization: boolean;
}

export interface CloudTranscriptionRequest {
  provider: CloudTranscriptionProvider;
  audio: Uint8Array;
  language: string;
  diarize: boolean;
}

export interface NormalizedTranscriptWord {
  text: string;
  start: number;
  end: number;
  speaker: string | null;
}

export interface NormalizedTranscriptUtterance {
  speaker: string;
  text: string;
  start: number;
  end: number;
  words: NormalizedTranscriptWord[];
}

export interface NormalizedTranscriptResult {
  text: string;
  words: NormalizedTranscriptWord[];
  utterances: NormalizedTranscriptUtterance[];
}

export function isCloudTranscriptionProvider(value: string): value is CloudTranscriptionProvider {
  return (CLOUD_TRANSCRIPTION_PROVIDERS as readonly string[]).includes(value);
}
