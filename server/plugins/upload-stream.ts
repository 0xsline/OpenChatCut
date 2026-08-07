import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import {
  createContentHashAccumulator,
  type ContentHashResult,
} from '../../shared/node-content-hash.ts';
import { UploadTooLargeError } from '../r2.ts';

/** Write and hash one upload stream with bounded byte accounting and cleanup. */
export async function streamUploadToFile(
  source: Readable | NodeJS.ReadableStream,
  destination: string,
  maxBytes: number,
): Promise<ContentHashResult> {
  const accumulator = createContentHashAccumulator({
    maxBytes,
    limitError: (limit) => new UploadTooLargeError(limit),
  });
  try {
    await pipeline(
      source as Readable,
      accumulator.createTransform(),
      createWriteStream(destination),
    );
  } catch (error) {
    await unlink(destination).catch(() => {});
    throw error;
  }
  return accumulator.digest();
}
