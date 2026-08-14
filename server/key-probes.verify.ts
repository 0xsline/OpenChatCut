// checks:key-probes pure logic - detection table coverage, override whitelist, status classification,
// MiniMax base_resp post-check, runProbe does not hit the network early exit. There are no real network requests in the whole process.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LLM_PROVIDER_PRESETS } from '../shared/llm-providers.ts';

// Directory probes answer from the runtime profile, which resolves once at module load
// out of HOME and the profile environment. Pin both to a throwaway home before importing
// the module under test: otherwise a developer's own storage root, or an exported dev
// profile id, decides the outcome of the directory assertions below.
const fixtureHome = mkdtempSync(join(tmpdir(), 'openchatcut-key-probes-'));
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;
delete process.env.OPENCHATCUT_DEV_PROFILE_ID;
delete process.env.OPENCHATCUT_DATA_DIR;
process.on('exit', () => rmSync(fixtureHome, { recursive: true, force: true }));

const {
  PROBES, classifyStatus, makeGetter, minimaxPostCheck, networkMessage, runProbe, runProxyProbe,
} = await import('./key-probes.ts');

// 1. One-to-one correspondence with the provider page of settingsSchema (the page key has the same name); the llm page is derived from the preset,
// Synchronize this list when adding other capability pages.
const EXPECTED_PAGES = [
  ...LLM_PROVIDER_PRESETS.map((preset) => `llm/${preset.id}`),
  'image/openai', 'image/gemini', 'image/minimax', 'image/wavespeed', 'image/byteplus',
  'voice/elevenlabs', 'voice/openai', 'voice/gemini', 'voice/mistral', 'voice/cartesia',
  'voice/doubao', 'voice/minimax', 'voice/inworld', 'voice/fishaudio', 'voice/speechify',
  'video/seedance', 'video/kling', 'video/hailuo', 'video/byteplus',
  'music/mureka', 'music/minimax',
  'stock/pexels', 'stock/pixabay', 'stock/unsplash', 'stock/freesound',
  'transcription/assemblyai', 'transcription/openai', 'transcription/mistral',
  'transcription/deepgram', 'transcription/groq', 'transcription/elevenlabs', 'transcription/cartesia',
  'sandbox/e2b',
  'web/firecrawl',
  'storage/r2', 'storage/local',
];
for (const page of EXPECTED_PAGES) assert.ok(PROBES[page], `probe missing for ${page}`);
assert.equal(Object.keys(PROBES).length, EXPECTED_PAGES.length, 'PROBES 有清单外的多余页');

// 2. Override whitelist: items outside the whitelist will be discarded, empty values ​​will not be covered, and values ​​will be trimmed.
{
  const get = makeGetter({ ELEVENLABS_API_KEY: '  k1  ', NOT_A_KEY: 'x', LLM_API_KEY: '   ' });
  assert.equal(get('ELEVENLABS_API_KEY'), 'k1');
  assert.equal(get('LLM_API_KEY'), '');   // Blank override does not take effect; keystore is not seeded and has no value
  assert.equal(get('MINIMAX_API_KEY'), '');
}

// 3. Status classification: Authentication / Address / Current Limiting / Others, each has a clear conclusion.
assert.equal(classifyStatus(401, '').ok, false);
assert.match(classifyStatus(401, '').message, /鉴权失败/);
assert.match(classifyStatus(403, '').message, /鉴权失败/);
assert.match(classifyStatus(404, '').message, /Base URL/);
assert.equal(classifyStatus(429, '').ok, true);
assert.match(classifyStatus(429, '').message, /限流/);
{
  const r = classifyStatus(500, 'boom\n  line2\ttail');
  assert.equal(r.ok, false);
  assert.match(r.message, /HTTP 500 · boom line2 tail/); // flatten whitespace
  assert.ok(classifyStatus(500, 'x'.repeat(500)).message.length < 200, '厂商长报错要截断');
}

// 4. MiniMax base_resp:0 = success; non-0 means provider-level failure (HTTP 200 is also considered a failure); non-JSON is released.
assert.equal(minimaxPostCheck(JSON.stringify({ base_resp: { status_code: 0 } })), null);
assert.match(minimaxPostCheck(JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'invalid api key' } })) ?? '', /1004.*鉴权失败/);
assert.match(minimaxPostCheck(JSON.stringify({ base_resp: { status_code: 2049 } })) ?? '', /2049/);
assert.equal(minimaxPostCheck('not json'), null);

// 5. Network layer failure copy: clearly "does not mean Key error", and timeout is worded separately.
assert.match(networkMessage(new TypeError('fetch failed')), /网络不可达[\s\S]*不代表 Key 错误/);
assert.match(networkMessage(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })), /超时/);

// 6. runProbe exits early: Unknown page / Key is not configured and does not connect to the network (keystore is empty, synchronization will return).
{
  const unknown = await runProbe('nope/vendor', {});
  assert.equal(unknown.ok, false);
  assert.match(unknown.message, /暂不支持/);
  const unconfigured = await runProbe('voice/elevenlabs', {});
  assert.equal(unconfigured.ok, false);
  assert.match(unconfigured.message, /尚未填写 API Key/);
  // Doubao requires both keys: only the App ID is still unconfigured
  const half = await runProbe('voice/doubao', { DOUBAO_TTS_APP_ID: 'a' });
  assert.match(half.message, /尚未填写 API Key/);
}

// 7. Proxy page uses its own connectivity semantics rather than provider/API-key language.
{
  const missing = await runProxyProbe({ PROXY_URL: '' });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /尚未填写代理地址/);
  const malformed = await runProxyProbe({ PROXY_URL: 'not a proxy url' });
  assert.equal(malformed.ok, false);
  assert.match(malformed.message, /代理地址格式无效/);
}

// 7. Media probes normalize Base URLs exactly like the runtime: keep an existing version suffix and add a missing one.
{
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return Response.json({ data: [] });
  };
  try {
    await runProbe('voice/openai', { OPENAI_API_KEY: 'test', IMAGE_BASE_URL: 'https://proxy.example/v1/' });
    await runProbe('voice/gemini', { GEMINI_API_KEY: 'test', GEMINI_BASE_URL: 'https://proxy.example/v1beta' });
    await runProbe('voice/mistral', { LLM_MISTRAL_API_KEY: 'test', LLM_MISTRAL_BASE_URL: 'https://proxy.example' });
    assert.deepEqual(urls, [
      'https://proxy.example/v1/models',
      'https://proxy.example/v1beta/models?pageSize=1',
      'https://proxy.example/v1/models',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
}


// 8. Local storage directory probe: empty group needs = can be tested if not filled in (not set = default directory); the relative path is configured
// Level failure (postCheck copy, no HTTP prefix); success copy goes to okText. Neither case touched the plate.
{
  const unset = await runProbe('storage/local', {});
  assert.equal(unset.ok, true);
  assert.match(unset.message, /默认目录 .*public[/\\]media[/\\]uploads/); // The copy has a machine-related absolute path and only anchors the tail section.
  const relative = await runProbe('storage/local', { MEDIA_DIR: 'relative/path' });
  assert.equal(relative.ok, false);
  assert.match(relative.message, /绝对路径/);
  assert.doesNotMatch(relative.message, /HTTP/);
}

// 9. Project storage root probe: a local disk check, never a network request. Empty = the
// default root (legal), relative path rejected, writable folder accepted, and a root
// pinned by the environment refuses the change instead of pretending to accept it.
{
  const unset = await runProbe('storage/projects', { OPENCHATCUT_DATA_DIR: '' });
  assert.equal(unset.ok, true);
  assert.match(unset.message, /默认目录 .*\.openchatcut/); // machine-dependent absolute path, anchor the tail only

  const relative = await runProbe('storage/projects', { OPENCHATCUT_DATA_DIR: 'relative/saves' });
  assert.equal(relative.ok, false);
  assert.match(relative.message, /绝对路径/);
  assert.doesNotMatch(relative.message, /HTTP/);

  const target = join(fixtureHome, 'Saves');
  const writable = await runProbe('storage/projects', { OPENCHATCUT_DATA_DIR: target });
  assert.equal(writable.ok, true);
  assert.match(writable.message, /目录可写/);

  // Without the field in the payload, the probe tests the root already recorded by the
  // settings UI, so "test connection" answers for the storage actually in use.
  mkdirSync(join(fixtureHome, '.openchatcut'), { recursive: true });
  writeFileSync(
    join(fixtureHome, '.openchatcut', 'data-dir.json'),
    JSON.stringify({ version: 1, dataDir: target }),
  );
  const recorded = await runProbe('storage/projects', {});
  assert.equal(recorded.ok, true);
  assert.match(recorded.message, new RegExp(`目录可写 · ${target}`));

  process.env.OPENCHATCUT_DATA_DIR = target;
  try {
    const pinned = await runProbe('storage/projects', { OPENCHATCUT_DATA_DIR: join(fixtureHome, 'Elsewhere') });
    assert.equal(pinned.ok, false);
    assert.match(pinned.message, /固定/);
  } finally {
    delete process.env.OPENCHATCUT_DATA_DIR;
  }
}

console.log('key-probes.verify OK');
