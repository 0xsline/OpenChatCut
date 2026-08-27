import assert from 'node:assert/strict';
import { isFailedToolResult } from './toolFailure';
import {
  isSandboxNotConfiguredMessage,
  sandboxSkipFromHttpError,
  sandboxSkipIfUnconfigured,
  sandboxSkippedResult,
} from './sandbox-unavailable';

assert.equal(
  isSandboxNotConfiguredMessage('e2b sandbox is not configured. Set E2B_API_KEY in .env.local.'),
  true,
);
assert.equal(isSandboxNotConfiguredMessage('ffprobe exited 1'), false);

const skipped = sandboxSkippedResult('e2b sandbox is not configured. Set E2B_API_KEY in .env.local.');
assert.equal(skipped.ok, true);
assert.equal(skipped.skipped, true);
assert.match(skipped.note, /transform\.crop/);
assert.equal(isFailedToolResult(skipped), false, 'a missing sandbox must not abort the agent run');

const fromHttp = sandboxSkipFromHttpError('e2b sandbox is not configured. Set E2B_API_KEY in .env.local.');
assert.ok(fromHttp);
assert.equal(isFailedToolResult(fromHttp), false);
assert.equal(sandboxSkipFromHttpError('connection reset'), null);

const unconfigured = sandboxSkipIfUnconfigured();
assert.ok(unconfigured, 'tsx/default caps have no e2b sandbox');
assert.equal(isFailedToolResult(unconfigured), false);

console.log('sandbox-unavailable.verify: missing e2b is a skip, not a failed run');
