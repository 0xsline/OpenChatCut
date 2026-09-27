// PCM extraction for the desktop native-ASR worker: decode a local media file
// to mono float32 samples with the bundled FFmpeg. Kept free of worker state
// so it can be verified without a utility process.
import { spawn } from 'node:child_process';

const STDERR_LIMIT = 4_000;
const STDERR_IN_ERROR = 600;

/**
 * FFmpeg reads the source file itself rather than stdin: MP4/MOV/M4A files
 * whose moov atom sits at the end need a seekable input, and over a pipe the
 * demuxer yields zero samples while still exiting 0 (#167). Only the file
 * protocol is allowed, so a playlist or reference inside the media cannot
 * reach the network.
 */
export function pcmExtractionArgs(sourcePath: string, sampleRate: number): string[] {
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-protocol_whitelist', 'file', '-i', `file:${sourcePath}`,
    '-map', '0:a:0', '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', 'pipe:1',
  ];
}

export function decodePcm(chunks: readonly Buffer[], totalBytes: number): Float32Array {
  if (totalBytes === 0 || totalBytes % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error('FFmpeg returned invalid PCM audio');
  }
  const copy = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    copy.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Float32Array(copy.buffer);
}

function withStderr(message: string, stderr: string): Error {
  const detail = stderr.trim();
  return new Error(detail ? `${message}: ${detail.slice(-STDERR_IN_ERROR)}` : message);
}

/**
 * Every failure rejects, including an empty decode: throwing from the close
 * listener would escape the promise and take the whole utility process down.
 */
export function extractPcm(
  ffmpegPath: string,
  sourcePath: string,
  sampleRate: number,
): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, pcmExtractionArgs(sourcePath, sampleRate), {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      totalBytes += chunk.length;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_LIMIT);
    });
    child.once('error', (error) => reject(error));
    child.once('close', (code) => {
      if (code !== 0) {
        reject(withStderr(`FFmpeg PCM extraction failed (${code})`, stderr));
        return;
      }
      try {
        resolve(decodePcm(chunks, totalBytes));
      } catch (error) {
        reject(withStderr(error instanceof Error ? error.message : String(error), stderr));
      }
    });
  });
}
