import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createExportDirectoryGrant } from '../export-destinations';
import { handleExportDestinationPut } from './export-destination';

function request(url: string, body: string): IncomingMessage {
  const stream = Readable.from([Buffer.from(body)]) as IncomingMessage;
  stream.method = 'PUT';
  stream.url = url;
  stream.headers = { 'content-length': String(Buffer.byteLength(body)) };
  return stream;
}

function response(): ServerResponse {
  return {
    statusCode: 0,
    setHeader: () => undefined,
    end: () => undefined,
  } as unknown as ServerResponse;
}

const directory = await mkdtemp(join(tmpdir(), 'openchatcut-export-destination-'));
try {
  const grant = createExportDirectoryGrant(directory);
  assert.match(grant.grantId, /^[A-Za-z0-9_-]{32,128}$/);
  await handleExportDestinationPut(request(`/${grant.grantId}/clip.mp4`, 'first'), response());
  assert.equal(await readFile(join(directory, 'clip.mp4'), 'utf8'), 'first');
  await handleExportDestinationPut(request(`/${grant.grantId}/clip.mp4`, 'replacement'), response());
  assert.equal(await readFile(join(directory, 'clip.mp4'), 'utf8'), 'replacement');
  await assert.rejects(
    () => handleExportDestinationPut(request(`/${grant.grantId}/..%2Fevil.mp4`, 'bad'), response()),
    /invalid export filename/,
  );
  console.log('export destination server verification passed');
} finally {
  await rm(directory, { recursive: true, force: true });
}
