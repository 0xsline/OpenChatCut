import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { createExportDirectoryGrant } from '../export-destinations';
import { handleExportDestinationPut } from './export-destination';

function request(url: string, body: string): IncomingMessage {
  const stream = Readable.from([Buffer.from(body)]) as IncomingMessage;
  stream.method = 'PUT';
  stream.url = url;
  stream.headers = { 'content-length': String(Buffer.byteLength(body)) };
  return stream;
}

function streamingRequest(url: string): PassThrough & IncomingMessage {
  const stream = new PassThrough() as PassThrough & IncomingMessage;
  stream.method = 'PUT';
  stream.url = url;
  stream.headers = {};
  return stream;
}

function failedRequest(url: string): IncomingMessage {
  let emitted = false;
  const stream = new Readable({
    read() {
      if (emitted) return;
      emitted = true;
      this.push(Buffer.from('partial replacement'));
      this.destroy(new Error('simulated source failure'));
    },
  }) as IncomingMessage;
  stream.method = 'PUT';
  stream.url = url;
  stream.headers = {};
  return stream;
}

function sourceRequest(url: string, source: string): IncomingMessage {
  const stream = Readable.from([]) as IncomingMessage;
  stream.method = 'PUT';
  stream.url = url;
  stream.headers = { 'x-openchatcut-export-source': source };
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
  const route = `/${grant.grantId}/clip.mp4`;
  const held = streamingRequest(route);
  const first = handleExportDestinationPut(held, response());
  await assert.rejects(
    () => handleExportDestinationPut(request(route, 'racer'), response()),
    /already being written/,
    'the same canonical target must have one writer',
  );
  held.end('leased winner');
  await first;
  assert.equal(await readFile(join(directory, 'clip.mp4'), 'utf8'), 'leased winner');

  await writeFile(join(directory, 'clip.mp4'), 'stable old target');
  await assert.rejects(
    () => handleExportDestinationPut(failedRequest(route), response()),
    /simulated source failure/,
  );
  assert.equal(
    await readFile(join(directory, 'clip.mp4'), 'utf8'),
    'stable old target',
    'a failed partial write must never replace the previous target',
  );
  await handleExportDestinationPut(request(route, 'after failure'), response());
  assert.equal(
    await readFile(join(directory, 'clip.mp4'), 'utf8'),
    'after failure',
    'failure must release the target lease',
  );
  await assert.rejects(
    () => handleExportDestinationPut(request(route, ''), response()),
    (error) => error instanceof Error
      && 'code' in error
      && error.code === 'export_output_empty'
      && error.message === 'export file is empty',
  );
  assert.equal(
    await readFile(join(directory, 'clip.mp4'), 'utf8'),
    'after failure',
    'an empty request must not replace the previous target',
  );
  const source = join(directory, 'source.mp4');
  const localizedName = '狗零食嘎嘎棒mini.mp4';
  await writeFile(source, 'server-side export copy');
  await handleExportDestinationPut(
    sourceRequest(`/${grant.grantId}/${encodeURIComponent(localizedName)}`, '/media/uploads/source.mp4'),
    response(),
    (name) => name === 'source.mp4' ? source : null,
  );
  assert.equal(await readFile(join(directory, localizedName), 'utf8'), 'server-side export copy');
  const emptySource = join(directory, 'empty-source.mp4');
  await writeFile(emptySource, '');
  await assert.rejects(
    () => handleExportDestinationPut(
      sourceRequest(`/${grant.grantId}/empty.mp4`, '/media/uploads/empty-source.mp4'),
      response(),
      (name) => name === 'empty-source.mp4' ? emptySource : null,
    ),
    /export file is empty/,
  );
  await assert.rejects(
    () => handleExportDestinationPut(
      sourceRequest(`/${grant.grantId}/missing.mp4`, '/media/uploads/missing.mp4'),
      response(),
      () => null,
    ),
    /export source is unavailable/,
  );
  console.log('export destination server verification passed');
} finally {
  await rm(directory, { recursive: true, force: true });
}
