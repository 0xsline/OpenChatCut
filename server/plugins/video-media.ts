import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { isSafeUploadName, resolveUploadFile, uploadDir } from '../media-dir.ts';
import { presignGetUpload, putUploadFile } from '../r2.ts';

function mimeFor(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.wav') return 'audio/wav';
  if (extension === '.mp4') return 'video/mp4';
  if (extension === '.webm') return 'video/webm';
  if (extension === '.mp3') return 'audio/mpeg';
  return 'image/jpeg';
}

export async function mediaDataUrl(path: string): Promise<string> {
  const { file } = localMedia(path);
  const bytes = await readFile(file);
  return `data:${mimeFor(file)};base64,${bytes.toString('base64')}`;
}

function localMedia(path: string): { file: string; name: string } {
  const clean = path.split(/[?#]/, 1)[0];
  if (!clean.startsWith('/media/uploads/')) throw new Error(`provider reference must be a project upload: ${path}`);
  const name = clean.slice('/media/uploads/'.length);
  if (!isSafeUploadName(name)) throw new Error('invalid project media path');
  const file = resolveUploadFile(name);
  if (!file) throw new Error(`project media not found: ${name}`);
  return { file, name };
}

/** Providers that reject base64 video receive a temporary private-bucket URL. */
export async function providerMediaUrl(path: string): Promise<string> {
  const { file, name } = localMedia(path);
  await putUploadFile(name, file, mimeFor(file));
  const signed = await presignGetUpload(name, 3600);
  if (!signed) throw new Error('video references require configured R2 storage so the provider can fetch a temporary HTTPS URL');
  return signed.downloadUrl;
}

async function probeVideo(file: string): Promise<{ durationSeconds: number; width?: number; height?: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file]);
    let output = '';
    child.stdout.on('data', (data) => { output += String(data); });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        const parsed = JSON.parse(output) as { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
        const durationSeconds = Number(parsed.format?.duration);
        if (code !== 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error();
        resolvePromise({ durationSeconds, width: parsed.streams?.[0]?.width, height: parsed.streams?.[0]?.height });
      } catch {
        reject(new Error('unable to probe generated video'));
      }
    });
  });
}

export async function saveVideo(url: string): Promise<{ path: string; durationSeconds: number; width?: number; height?: number }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`generated video download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error('video provider returned empty video');
  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  const filename = `${randomUUID()}.mp4`;
  const file = join(dir, filename);
  await writeFile(file, bytes);
  return { path: `/media/uploads/${filename}`, ...await probeVideo(file) };
}

export async function saveImageUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`generated image download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error('provider returned an empty last frame');
  const contentType = response.headers.get('content-type') ?? '';
  const urlExt = extname(new URL(url).pathname).slice(1).toLowerCase();
  const ext = contentType.includes('webp') || urlExt === 'webp' ? 'webp'
    : contentType.includes('jpeg') || urlExt === 'jpg' || urlExt === 'jpeg' ? 'jpg' : 'png';
  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  const filename = `${randomUUID()}.${ext}`;
  await writeFile(join(dir, filename), bytes);
  return `/media/uploads/${filename}`;
}
