import assert from 'node:assert/strict';
import { resolveUpstreamUpdateAction } from './upstreamUpdateAction';
import { formatDisplayVersion, mapDesktopUpdateState, queryLatestUpstreamRelease } from './upstreamUpdate';

assert.equal(formatDisplayVersion('0.1.7'), 'V0.1.7');
assert.equal(formatDisplayVersion('v0.1.7'), 'V0.1.7');

const samples = [
  { current: '0.1.7', tag: 'v0.1.7', available: false },
  { current: '0.1.7', tag: 'v0.1.8', available: true },
  { current: '0.2.0', tag: 'v0.1.9', available: false },
  { current: '0.1.8-beta.1', tag: 'v0.1.8', available: true },
] as const;

for (const sample of samples) {
  let requestedUrl = '';
  const result = await queryLatestUpstreamRelease(sample.current, async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ tag_name: sample.tag }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  assert.equal(requestedUrl, 'https://api.github.com/repos/0xsline/OpenChatCut/releases/latest');
  assert.equal(result.latestVersion, sample.tag);
  assert.equal(result.updateAvailable, sample.available, `${sample.current} compared with ${sample.tag}`);
}

await assert.rejects(
  queryLatestUpstreamRelease('0.1.7', async () => new Response('{}', { status: 200 })),
  /valid release version/i,
  'missing tag_name should fail instead of reporting a false update',
);

const availableState = mapDesktopUpdateState({
  phase: 'available',
  currentVersion: '0.1.9',
  latestVersion: '0.2.0',
  source: 'manual',
});
assert.deepEqual(availableState, {
  phase: 'available',
  visible: true,
  currentVersion: '0.1.9',
  latestVersion: '0.2.0',
  source: 'manual',
});
assert.equal(resolveUpstreamUpdateAction(availableState, true).command, 'download');
assert.equal(resolveUpstreamUpdateAction(availableState, false).command, 'view-release');

const downloadingState = mapDesktopUpdateState({
  phase: 'downloading',
  currentVersion: '0.1.9',
  latestVersion: '0.2.0',
  source: 'manual',
  percent: 142,
});
assert.equal(downloadingState.phase, 'downloading');
assert.equal(downloadingState.phase === 'downloading' ? downloadingState.percent : -1, 100);
assert.equal(resolveUpstreamUpdateAction(downloadingState, true).disabled, true);

const failedInstallState = mapDesktopUpdateState({
  phase: 'error',
  currentVersion: '0.1.9',
  latestVersion: '0.2.0',
  source: 'manual',
  failedOperation: 'install',
});
assert.equal(failedInstallState.phase, 'error');
assert.equal(resolveUpstreamUpdateAction(failedInstallState, true).command, 'install');

assert.deepEqual(mapDesktopUpdateState({
  phase: 'unsupported',
  currentVersion: '0.1.9',
  source: 'auto',
}), { phase: 'idle', visible: false });

console.log('upstreamUpdate.verify: official release comparison passed');
