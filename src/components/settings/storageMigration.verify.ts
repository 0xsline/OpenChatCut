import assert from 'node:assert/strict';
import { cleanupLegacyJson, loadMigrationStatus, runStorageMigrationRequest } from './storageMigration';

const originalFetch = globalThis.fetch;

function mockResponse(body: string, init: ResponseInit): void {
  globalThis.fetch = async () => new Response(body, init);
}

try {
  mockResponse('<!doctype html><html><body>OpenChatCut</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
  await assert.rejects(
    () => loadMigrationStatus(),
    /Storage migration endpoint returned HTML instead of JSON \(HTTP 200\)/,
  );

  mockResponse('not found', {
    status: 404,
    headers: { 'content-type': 'text/plain' },
  });
  await assert.rejects(
    () => runStorageMigrationRequest(),
    /Storage migration endpoint unavailable \(HTTP 404\): not found/,
  );

  mockResponse('not found', {
    status: 404,
    headers: { 'content-type': 'text/plain' },
  });
  await assert.rejects(
    () => cleanupLegacyJson(),
    /Storage migration endpoint unavailable \(HTTP 404\): not found/,
  );

  console.log('storageMigration.verify: non-JSON endpoint responses produce actionable errors');
} finally {
  globalThis.fetch = originalFetch;
}
