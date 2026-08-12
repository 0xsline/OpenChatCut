// Pure helpers shared between the native-ASR worker and its verification.
import type { DesktopAsrChunk } from '../shared/desktop-inference.ts';
import { ASR_INFERENCE_CONTRACT } from '../shared/asr-inference-contract.ts';

export const NATIVE_ASR_SAMPLE_RATE = ASR_INFERENCE_CONTRACT.sampleRate;

export interface WhisperWordToken {
  readonly text?: string;
  readonly offsets?: { from: number; to: number };
}

export interface WhisperJsonSegment {
  readonly text?: string;
  readonly tokens?: readonly WhisperWordToken[];
}

export interface WhisperJson {
  readonly transcription?: readonly WhisperJsonSegment[];
}

export function whisperLanguage(language: string | undefined): string {
  const value = (language ?? '').trim().toLowerCase();
  if (!value || value === 'auto' || value === 'autodetect') return 'auto';
  if (value.startsWith('zh') || value === 'cmn' || value === 'yue') return 'zh';
  if (value.startsWith('en')) return 'en';
  return value.slice(0, 3);
}

/** Project whisper.cpp token output into the desktop ASR chunk contract. */
export function whisperTokensToChunks(
  transcription: readonly WhisperJsonSegment[] | undefined,
): { text: string; chunks: DesktopAsrChunk[] } {
  const chunks: DesktopAsrChunk[] = [];
  let text = '';
  for (const segment of transcription ?? []) {
    const segmentText = (segment.text ?? '').trim();
    if (segmentText) text = text ? `${text}\n${segmentText}` : segmentText;
    for (const token of segment.tokens ?? []) {
      const tokenText = (token.text ?? '').trim();
      const offsets = token.offsets;
      if (!tokenText || !offsets
        || typeof offsets.from !== 'number' || typeof offsets.to !== 'number') continue;
      if (/[<>,_.!?。，、！？；：""''《》\s]+$/.test(tokenText)) continue;
      if (tokenText.startsWith('[') || tokenText.endsWith(']')) continue;
      chunks.push({
        text: tokenText,
        start: Math.round(offsets.from),
        end: Math.round(offsets.to),
      });
    }
  }
  return { text, chunks };
}

export async function writeWav(samples: Float32Array, path: string): Promise<void> {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.length * 2, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(NATIVE_ASR_SAMPLE_RATE, 24);
  header.writeUInt32LE(NATIVE_ASR_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.length * 2, 40);
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    pcm.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, Buffer.concat([header, pcm]));
}
