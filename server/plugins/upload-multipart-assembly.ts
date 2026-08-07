import { createReadStream, createWriteStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import {
  createContentHashAccumulator,
  type ContentHashResult,
} from '../../shared/node-content-hash.ts';

/** Concatenate ordered part files while hashing the exact published byte stream. */
export async function assembleHashedParts(
  partPaths: readonly string[],
  destination: string,
): Promise<ContentHashResult> {
  await unlink(destination).catch(() => {});
  const output = createWriteStream(destination);
  const accumulator = createContentHashAccumulator();
  let total = 0;
  try {
    for (const path of partPaths) {
      const info = await stat(path);
      if (info.size > Number.MAX_SAFE_INTEGER - total) {
        throw new Error('multipart file exceeds safe byte accounting range');
      }
      total += info.size;
      await pipeline(
        createReadStream(path),
        accumulator.createTransform(),
        output,
        { end: false },
      );
    }
    await new Promise<void>((resolve, reject) => {
      output.end(resolve);
      output.on('error', reject);
    });
  } catch (error) {
    output.destroy();
    await unlink(destination).catch(() => {});
    throw error;
  }
  return accumulator.digest();
}
