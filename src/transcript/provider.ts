// Transcription provider routing: cloud AssemblyAI vs on-device whisper.
// Consumers import from here (previously from './assemblyai') — exports stay
// signature-compatible so callers change only the import line. The choice is a
// plain localStorage flag (default assemblyai), written by the settings panel.
import type { TranscriptResult, TranscriptionProviderId } from './types';
import {
  transcribePathResumable as assemblyaiTranscribePathResumable,
  type AssemblyAiProviderStatus,
  type AssemblyAiResumeCheckpoint,
  type AssemblyAiCheckpointWriter,
  type TranscribeOptions,
} from './assemblyai';
import { localTranscribePathResumable } from './local-asr';

export const TRANSCRIPTION_PROVIDER_KEY = 'cc.transcriptionProvider';

export function preferredTranscriptionProvider(): TranscriptionProviderId {
  try {
    const value = localStorage.getItem(TRANSCRIPTION_PROVIDER_KEY);
    if (value === 'local' || value === 'assemblyai') return value;
  } catch {
    // SSR / private browsing: fall through to the default.
  }
  return 'assemblyai';
}

export function setPreferredTranscriptionProvider(provider: TranscriptionProviderId): void {
  try {
    localStorage.setItem(TRANSCRIPTION_PROVIDER_KEY, provider);
  } catch {
    // Best-effort; the default stays in effect.
  }
}

export type { AssemblyAiProviderStatus, AssemblyAiResumeCheckpoint, AssemblyAiCheckpointWriter, TranscribeOptions };
export { TranscriptionError, extractAudioForAsr, transcriptionSourceForPath } from './assemblyai';

export type TranscriptionCheckpointWriter = AssemblyAiCheckpointWriter;

/**
 * Route to the current provider. Cloud: upload → create → poll (resumable via
 * durable checkpoint). Local: extract 16 kHz audio → on-device whisper worker
 * (resume is accepted for interface parity; local jobs always rerun).
 */
export async function transcribePathResumable(
  path: string,
  resume: AssemblyAiResumeCheckpoint,
  onCheckpoint: AssemblyAiCheckpointWriter,
  onWait?: (note?: string) => void,
  opts: TranscribeOptions = {},
): Promise<TranscriptResult> {
  if (preferredTranscriptionProvider() === 'local') {
    return localTranscribePathResumable(path, resume, onCheckpoint, onWait, opts);
  }
  return assemblyaiTranscribePathResumable(path, resume, onCheckpoint, onWait, opts);
}

export async function transcribePath(
  path: string,
  onWait?: (note?: string) => void,
  opts: TranscribeOptions = {},
): Promise<TranscriptResult> {
  return transcribePathResumable(path, {}, () => {}, onWait, opts);
}
