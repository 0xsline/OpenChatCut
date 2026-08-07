import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, stat, unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { ffmpegBin, ffprobeBin } from '../server/media-binaries.ts';
import { uploadDir } from '../server/media-dir.ts';
import { normalizeSha256Hash } from '../shared/content-hash.ts';
import { sha256File } from '../shared/node-content-hash.ts';

export interface LocalMediaImport {
  src: string;
  storedName: string;
  contentHash: string;
}

export interface LocalMediaImportDependencies {
  stat(path: string): Promise<{ isFile(): boolean; size: number }>;
  copyFile(source: string, destination: string, mode: number): Promise<void>;
  hashFile(path: string): Promise<string>;
}

const DEFAULT_LOCAL_MEDIA_IMPORT_DEPENDENCIES: LocalMediaImportDependencies = {
  stat: (path) => stat(path),
  copyFile: (source, destination, mode) => copyFile(source, destination, mode),
  hashFile: sha256File,
};

type ProbeStream = {
  codec_name?: unknown;
  profile?: unknown;
  pix_fmt?: unknown;
  tags?: { alpha_mode?: unknown };
};

function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1_000)}s`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += String(chunk); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

/** Detect alpha from the probed pixel format rather than container or filename. */
export function hasAlphaPixelFormat(value: unknown): boolean {
  const format = String(value ?? '').trim().toLowerCase();
  return /^(?:yuva|gbrap|rgba|argb|bgra|abgr|ya)/.test(format);
}

export function isTransparentMovProbe(stream: ProbeStream | undefined): boolean {
  if (!stream) return false;
  if (hasAlphaPixelFormat(stream.pix_fmt)) return true;
  return String(stream.tags?.alpha_mode ?? '') === '1';
}

export function transparentMovProxyArgs(source: string, destination: string): string[] {
  return [
    '-y', '-i', source,
    '-map', '0:v:0', '-map', '0:a?',
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p',
    '-metadata:s:v:0', 'alpha_mode=1', '-auto-alt-ref', '0',
    '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1',
    '-c:a', 'libopus',
    destination,
  ];
}

export async function importLocalMedia(
  sourcePath: string,
  originalName: string,
  dependencies: LocalMediaImportDependencies = DEFAULT_LOCAL_MEDIA_IMPORT_DEPENDENCIES,
): Promise<LocalMediaImport> {
  const sourceInfo = await dependencies.stat(sourcePath);
  if (!sourceInfo.isFile()) throw new Error('local media source must be a file');
  const extension = extname(originalName).toLowerCase();
  const storedName = `${randomUUID()}${extension}`;
  const directory = uploadDir();
  const destination = join(directory, storedName);
  await mkdir(directory, { recursive: true });
  // COPYFILE_FICLONE attempts a copy-on-write clone and transparently falls
  // back to a regular copy when the filesystem does not support cloning.
  // Either path creates an inode independent from the source.
  await dependencies.copyFile(sourcePath, destination, constants.COPYFILE_FICLONE);
  try {
    const contentHash = normalizeSha256Hash(await dependencies.hashFile(destination));
    if (!contentHash) throw new Error('local media hash must be a SHA-256 hex digest');
    return { src: `/media/uploads/${storedName}`, storedName, contentHash };
  } catch (error) {
    await unlink(destination).catch(() => {});
    throw error;
  }
}

/** Return null for ordinary MOV files and never replace or remove the original. */
export async function createTransparentMovProxy(storedName: string): Promise<{ src: string } | null> {
  if (extname(storedName).toLowerCase() !== '.mov' || basename(storedName) !== storedName) return null;
  const source = join(uploadDir(), storedName);
  const probe = JSON.parse(await run(ffprobeBin(), [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,profile,pix_fmt:stream_tags=alpha_mode',
    '-of', 'json', source,
  ], 10_000)) as { streams?: ProbeStream[] };
  if (!isTransparentMovProbe(probe.streams?.[0])) return null;

  const proxyName = `${basename(storedName, '.mov')}.alpha.webm`;
  const destination = join(uploadDir(), proxyName);
  await run(ffmpegBin(), transparentMovProxyArgs(source, destination), 60 * 60_000);
  return { src: `/media/uploads/${proxyName}` };
}
