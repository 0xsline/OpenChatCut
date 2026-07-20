// checks:key-probes 纯逻辑 — 探测表覆盖面、override 白名单、状态分类、
// MiniMax base_resp 后置校验、runProbe 的不打网络早退。全程无真实网络请求。
import assert from 'node:assert/strict';
import { PROBES, classifyStatus, makeGetter, minimaxPostCheck, networkMessage, runProbe } from './key-probes.ts';

// 1. 与 settingsSchema 的厂商页一一对应(page key 同名);两边加页时同步这份清单。
const EXPECTED_PAGES = [
  'llm/anthropic',
  'image/openai', 'image/gemini', 'image/minimax',
  'voice/elevenlabs', 'voice/doubao', 'voice/minimax',
  'video/seedance', 'video/kling', 'video/hailuo',
  'music/mureka', 'music/minimax',
  'stock/pexels', 'stock/pixabay', 'stock/unsplash', 'stock/freesound',
  'transcription/assemblyai',
  'sandbox/e2b',
  'web/firecrawl',
  'storage/r2', 'storage/local',
];
for (const page of EXPECTED_PAGES) assert.ok(PROBES[page], `probe missing for ${page}`);
assert.equal(Object.keys(PROBES).length, EXPECTED_PAGES.length, 'PROBES 有清单外的多余页');

// 2. override 白名单:白名单外丢弃、空值不覆盖、值会 trim。
{
  const get = makeGetter({ ELEVENLABS_API_KEY: '  k1  ', NOT_A_KEY: 'x', LLM_API_KEY: '   ' });
  assert.equal(get('ELEVENLABS_API_KEY'), 'k1');
  assert.equal(get('LLM_API_KEY'), '');   // 空白 override 不生效;keystore 未 seed 也无值
  assert.equal(get('MINIMAX_API_KEY'), '');
}

// 3. 状态分类:鉴权 / 地址 / 限流 / 其他 各有明确结论。
assert.equal(classifyStatus(401, '').ok, false);
assert.match(classifyStatus(401, '').message, /鉴权失败/);
assert.match(classifyStatus(403, '').message, /鉴权失败/);
assert.match(classifyStatus(404, '').message, /Base URL/);
assert.equal(classifyStatus(429, '').ok, true);
assert.match(classifyStatus(429, '').message, /限流/);
{
  const r = classifyStatus(500, 'boom\n  line2\ttail');
  assert.equal(r.ok, false);
  assert.match(r.message, /HTTP 500 · boom line2 tail/); // 压平空白
  assert.ok(classifyStatus(500, 'x'.repeat(500)).message.length < 200, '厂商长报错要截断');
}

// 4. MiniMax base_resp:0 = 成功;非 0 是厂商级失败(HTTP 200 也算失败);非 JSON 放行。
assert.equal(minimaxPostCheck(JSON.stringify({ base_resp: { status_code: 0 } })), null);
assert.match(minimaxPostCheck(JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'invalid api key' } })) ?? '', /1004.*鉴权失败/);
assert.match(minimaxPostCheck(JSON.stringify({ base_resp: { status_code: 2049 } })) ?? '', /2049/);
assert.equal(minimaxPostCheck('not json'), null);

// 5. 网络层失败文案:明确「不代表 Key 错误」,超时单独措辞。
assert.match(networkMessage(new TypeError('fetch failed')), /网络不可达[\s\S]*不代表 Key 错误/);
assert.match(networkMessage(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })), /超时/);

// 6. runProbe 早退:未知页 / 未配置 Key 都不打网络(keystore 空,同步即回)。
{
  const unknown = await runProbe('nope/vendor', {});
  assert.equal(unknown.ok, false);
  assert.match(unknown.message, /暂不支持/);
  const unconfigured = await runProbe('voice/elevenlabs', {});
  assert.equal(unconfigured.ok, false);
  assert.match(unconfigured.message, /尚未填写 API Key/);
  // 豆包需要双 key 齐:只有 App ID 仍算未配置
  const half = await runProbe('voice/doubao', { DOUBAO_TTS_APP_ID: 'a' });
  assert.match(half.message, /尚未填写 API Key/);
}

// 7. 本地保存目录探针:空组 needs = 未填也可测(未设=默认目录);相对路径是配置
// 级失败(postCheck 文案,无 HTTP 前缀);成功文案走 okText。两例均不触盘。
{
  const unset = await runProbe('storage/local', {});
  assert.equal(unset.ok, true);
  assert.match(unset.message, /默认 public\/media\/uploads/);
  const relative = await runProbe('storage/local', { MEDIA_DIR: 'relative/path' });
  assert.equal(relative.ok, false);
  assert.match(relative.message, /绝对路径/);
  assert.doesNotMatch(relative.message, /HTTP/);
}

console.log('key-probes.check OK');
