// Pure helpers shared between the native-ASR worker and its verification.
import type { DesktopAsrChunk } from '../shared/desktop-inference.ts';
import { ASR_INFERENCE_CONTRACT } from '../shared/asr-inference-contract.ts';
import { ASR_MODELS } from '../shared/asr-models.ts';

export const NATIVE_ASR_SAMPLE_RATE = ASR_INFERENCE_CONTRACT.sampleRate;

// Every catalog tier that can run natively records its GGML companion in
// shared/asr-models.ts. The map that used to patch small/medium here named a
// `ggml-medium-q5_1.bin` that does not exist upstream (whisper.cpp ships
// medium as q5_0), so the desktop engine could never load it.
export function nativeGgmlFileName(modelId: string): string | undefined {
  return ASR_MODELS.find((model) => model.modelId === modelId)?.ggmlFile?.fileName;
}

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

// whisper.cpp emits BPE tokens, not words: only a token whose raw text begins
// with whitespace opens a new word (" Привет"), and the pieces that follow
// continue it ("тест" + "ов" + "ая" = "тестовая"); punctuation belongs to the
// word it trails. Scripts written without spaces (Han/kana, Thai, Lao,
// Myanmar, Khmer) carry no such whitespace, so each token opens a chunk;
// transformers.js splits the browser ONNX path the same way for its space-less
// language list (Chinese, Japanese, Thai, Lao, Myanmar). Korean uses spaces
// (whisper.cpp splits 안녕하세요 into 안녕 + 하세요), so Hangul joins like
// Russian instead of fragmenting.
const NO_SPACE_SCRIPT_TOKEN =
  /[\u0E00-\u0E7F\u0E80-\u0EFF\u1000-\u109F\u1780-\u17FF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\u{20000}-\u{2FA1F}]/u;

interface MutableChunk {
  text: string;
  start: number;
  end: number;
}

/**
 * Append one whisper token to the word being built: only a token that opens a
 * word (leading whitespace, or the first character of a script that does not
 * use spaces) starts a new chunk; continuations and trailing punctuation
 * extend the word before them.
 */
function appendWhisperToken(chunks: MutableChunk[], rawText: string, start: number, end: number): void {
  const text = rawText.trim();
  if (!text) return;
  const previous = chunks[chunks.length - 1];
  // `text[0]` tears surrogate pairs, and the CJK extension ranges are astral:
  // test the first code point.
  const first = String.fromCodePoint(text.codePointAt(0)!);
  if (!previous || /^\s/.test(rawText) || NO_SPACE_SCRIPT_TOKEN.test(first)) {
    chunks.push({ text, start, end });
    return;
  }
  previous.text += text;
  previous.end = Math.max(previous.end, end);
}

/** Project whisper.cpp token output into the desktop ASR chunk contract. */
export function whisperTokensToChunks(
  transcription: readonly WhisperJsonSegment[] | undefined,
): { text: string; chunks: DesktopAsrChunk[] } {
  const chunks: MutableChunk[] = [];
  let text = '';
  for (const segment of transcription ?? []) {
    const segmentText = (segment.text ?? '').trim();
    if (segmentText) text = text ? `${text}\n${segmentText}` : segmentText;
    for (const token of segment.tokens ?? []) {
      const tokenText = (token.text ?? '').trim();
      const offsets = token.offsets;
      if (!tokenText || !offsets
        || typeof offsets.from !== 'number' || typeof offsets.to !== 'number') continue;
      if (tokenText.startsWith('[') || tokenText.endsWith(']')) continue;
      appendWhisperToken(chunks, token.text ?? '', Math.round(offsets.from), Math.round(offsets.to));
    }
  }
  return { text, chunks };
}

/** Project whisper.cpp server verbose_json words (BPE tokens) into the chunk contract. */
export function whisperWordsToChunks(
  words: readonly { word?: string; start?: number; end?: number }[] | undefined,
): DesktopAsrChunk[] {
  const chunks: MutableChunk[] = [];
  for (const word of words ?? []) {
    const text = (word.word ?? '').trim();
    if (!text || typeof word.start !== 'number' || typeof word.end !== 'number') continue;
    if (text.startsWith('[') || text.endsWith(']')) continue;
    appendWhisperToken(chunks, word.word ?? '', Math.round(word.start * 1000), Math.round(word.end * 1000));
  }
  return chunks;
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
