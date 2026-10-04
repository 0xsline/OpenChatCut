import { createHash } from 'node:crypto';
import { openAsBlob, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';

import { isSafeUploadName, resolveUploadFile } from '../media-dir.ts';
import { UploadPostError } from './upload-post-client.ts';
import type { PublishRequest } from './upload-post.ts';

const VIDEO_EXTENSIONS: Readonly<Record<string, true>> = { '.mp4': true, '.mov': true, '.webm': true };
const HASH_CACHE_LIMIT = 64;
const hashCache = new Map<string, Promise<string>>();

export interface PublishSource {
  readonly name: string;
  readonly sizeBytes: number;
  /** File-backed snapshot: reading refuses if the file changes after approval checks. */
  readonly video: Blob;
  /** SHA-256 of the render's bytes, stable across media-directory moves. */
  readonly contentHash: string;
}

/** Resolve a `/media/uploads/<name>` render without buffering its video bytes. */
export async function resolvePublishSource(
  source: string,
  resolve: (name: string) => string | null = resolveUploadFile,
): Promise<PublishSource> {
  const clean = source.split(/[?#]/, 1)[0];
  if (!clean.startsWith('/media/uploads/')) {
    throw new UploadPostError(400, 'invalid_source', 'source must be a /media/uploads/ path (the downloadUrl from track_export)');
  }
  let name: string;
  try {
    name = decodeURIComponent(clean.slice('/media/uploads/'.length));
  } catch {
    throw new UploadPostError(400, 'invalid_source', 'invalid source path');
  }
  if (!isSafeUploadName(name)) throw new UploadPostError(400, 'invalid_source', 'invalid source path');
  const extension = extname(name).toLowerCase();
  if (!VIDEO_EXTENSIONS[extension]) {
    throw new UploadPostError(400, 'invalid_source', 'only MP4, MOV or WebM video renders can be published');
  }
  const file = resolve(name);
  if (!file) throw new UploadPostError(404, 'source_not_found', `render not found: ${source}`);
  const info = await stat(file);
  if (!info.isFile() || info.size === 0) throw new UploadPostError(422, 'source_empty', 'the render file is empty');
  const type = extension === '.webm' ? 'video/webm' : extension === '.mov' ? 'video/quicktime' : 'video/mp4';
  // Bracket opening and hashing with version checks: an atomic replacement must
  // not pair one file's Blob/hash with another file's cache metadata.
  const version = fileVersion(info);
  const video = await openAsBlob(file, { type });
  if (video.size !== info.size || version !== fileVersion(await stat(file))) {
    throw new UploadPostError(409, 'source_changed', 'The render changed while preparing it. Preview the finished render again.');
  }
  const hash = await contentHash(file, info, video);
  if (version !== fileVersion(await stat(file))) {
    throw new UploadPostError(409, 'source_changed', 'The render changed while preparing it. Preview the finished render again.');
  }
  return { name, video, sizeBytes: info.size, contentHash: hash };
}

function fileVersion(info: Stats): string {
  // ctime invalidates a same-size overwrite whose original mtime is restored.
  return `${info.dev}\n${info.ino}\n${info.size}\n${info.mtimeMs}\n${info.ctimeMs}`;
}

/** A moved file is rehashed once; preview/confirm reuse an unchanged file version. */
function contentHash(file: string, info: Stats, video: Blob): Promise<string> {
  const key = `${file}\n${fileVersion(info)}`;
  const cached = hashCache.get(key);
  if (cached) return cached;
  const hashing = (async () => {
    const hash = createHash('sha256');
    for await (const chunk of video.stream()) hash.update(chunk);
    return hash.digest('hex');
  })();
  if (hashCache.size >= HASH_CACHE_LIMIT) hashCache.delete(hashCache.keys().next().value!);
  hashCache.set(key, hashing);
  hashing.catch(() => hashCache.delete(key));
  return hashing;
}

/** Same endpoint/account/profile, render and publish fields mean the same post. */
export function publishRequestId(
  account: string,
  profile: string,
  source: Pick<PublishSource, 'name' | 'sizeBytes' | 'contentHash'>,
  request: PublishRequest,
): string {
  const identity = JSON.stringify([
    account, profile, source.name, source.sizeBytes, source.contentHash,
    [...request.platforms].sort(), request.title, request.description ?? '',
    request.youtubePrivacy, request.tiktokPrivacy ?? '', request.pinterestBoardId ?? '', request.aiGenerated,
  ]);
  return `ocut-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}
