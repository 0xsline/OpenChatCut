import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { isSafeUploadName, resolveUploadFile, uploadDir } from '../media-dir.ts';
import type { MusicAudioFormat } from './music-types.ts';

export async function musicProviderError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const data = JSON.parse(text) as { message?: string; detail?: string; error?: { message?: string } };
    return data.error?.message ?? data.message ?? data.detail ?? `music provider failed (${response.status})`;
  } catch {
    return text.slice(0, 300) || `music provider failed (${response.status})`;
  }
}

function probeDuration(file: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
    let output = '';
    child.stdout.on('data', (data) => { output += String(data); });
    child.on('error', reject);
    child.on('close', (code) => {
      const duration = Number(output.trim());
      if (code === 0 && Number.isFinite(duration) && duration > 0) resolvePromise(duration);
      else reject(new Error('unable to probe generated music'));
    });
  });
}

export async function saveAudioResponse(
  response: Response,
  format: MusicAudioFormat,
  rawSampleRate = 44_100,
): Promise<{ path: string; durationSeconds: number }> {
  if (!response.ok) throw new Error(await musicProviderError(response));
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error('music provider returned empty audio');
  const ext = ['wav', 'pcm', 'flac'].includes(format) ? format : 'mp3';
  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  const filename = `${randomUUID()}.${ext}`;
  const file = join(dir, filename);
  await writeFile(file, bytes);
  const durationSeconds = ext === 'pcm' ? bytes.length / (rawSampleRate * 2) : await probeDuration(file);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('unable to determine generated music duration');
  return { path: `/media/uploads/${filename}`, durationSeconds };
}

function localUpload(uploadPath: string): { file: string; name: string } {
  const clean = uploadPath.split(/[?#]/, 1)[0];
  if (!clean.startsWith('/media/uploads/')) throw new Error('music reference must be a project upload');
  const name = clean.slice('/media/uploads/'.length);
  if (!isSafeUploadName(name)) throw new Error('invalid music reference path');
  const file = resolveUploadFile(name);
  if (!file) throw new Error(`music reference not found: ${uploadPath}`);
  return { file, name };
}

export async function referenceAudioBase64(uploadPath: string): Promise<string> {
  const { file } = localUpload(uploadPath);
  const bytes = await readFile(file);
  if (bytes.length > 50 * 1024 * 1024) throw new Error('reference audio must be at most 50MB');
  if (!bytes.length) throw new Error('reference audio is empty');
  return bytes.toString('base64');
}

function mimeFor(file: string): string {
  const ext = extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.m4a') return 'audio/mp4';
  return ext === '.mp3' ? 'audio/mpeg' : 'application/octet-stream';
}

export async function uploadMurekaFile(
  baseUrl: string,
  apiKey: string,
  uploadPath: string,
  purpose: 'audio' | 'soundtrack',
): Promise<string> {
  const { file, name } = localUpload(uploadPath);
  const bytes = await readFile(file);
  const maxBytes = purpose === 'soundtrack' ? 100 * 1024 * 1024 : 10 * 1024 * 1024;
  if (bytes.length > maxBytes) throw new Error(`Mureka ${purpose} upload exceeds ${maxBytes / 1024 / 1024}MB`);
  const form = new FormData();
  form.append('purpose', purpose);
  form.append('file', new Blob([bytes], { type: mimeFor(file) }), name);
  const response = await fetch(`${baseUrl}/v1/files/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form,
  });
  if (!response.ok) throw new Error(await musicProviderError(response));
  const result = await response.json() as { id?: string };
  if (!result.id) throw new Error('Mureka file upload did not return an id');
  return result.id;
}
