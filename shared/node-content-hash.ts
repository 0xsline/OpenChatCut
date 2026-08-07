import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform, Writable, type Readable } from 'node:stream';

export interface ContentHashResult {
  bytes: number;
  contentHash: string;
}

export interface ContentHashAccumulator {
  createTransform(): Transform;
  digest(): ContentHashResult;
}

interface ContentHashOptions {
  maxBytes?: number;
  limitError?: (maxBytes: number) => Error;
}

/** Share one incremental digest across one or more sequential stream pipelines. */
export function createContentHashAccumulator(
  options: ContentHashOptions = {},
): ContentHashAccumulator {
  const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
  const hash = createHash('sha256');
  let bytes = 0;
  let digested = false;
  return {
    createTransform: () => new Transform({
      transform(chunk: Buffer, _encoding, done) {
        if (chunk.length > maxBytes - bytes) {
          done(options.limitError?.(maxBytes) ?? new Error(`stream exceeds ${maxBytes} bytes`));
          return;
        }
        bytes += chunk.length;
        hash.update(chunk);
        done(null, chunk);
      },
    }),
    digest: () => {
      if (digested) throw new Error('content hash already finalized');
      digested = true;
      return { bytes, contentHash: hash.digest('hex') };
    },
  };
}

export type FileReadStreamFactory = (path: string) => Readable;

/** Hash a file incrementally without allocating storage proportional to its size. */
export async function sha256File(
  path: string,
  openStream: FileReadStreamFactory = createReadStream,
): Promise<string> {
  const hash = createHash('sha256');
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      done();
    },
  });
  await pipeline(openStream(path), sink);
  return hash.digest('hex');
}
