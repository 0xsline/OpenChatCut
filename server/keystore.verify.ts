// keystore.verify.ts — .env merge (update / preserve / append / clear) and the
// booleans-only status contract of the settings keystore.
//   npx tsx server/keystore.verify.ts
import assert from 'node:assert/strict';
import { KEY_NAMES, NON_SECRET_NAMES, mergeEnvText, planLegacyLlmMigration, seedKeystore, keyStatus, getKey } from './keystore.ts';
import { LLM_PROVIDER_PRESETS, llmProviderConfigNames } from '../shared/llm-providers.ts';

const isolatedSeed = Object.fromEntries(KEY_NAMES.map((name) => [name, '']));

// ── Legacy unit group migration: only migrate if the current provider has no proprietary configuration; if there is any proprietary value, skip it altogether ──
{
  const mk = (entries: Record<string, string>) => {
    const m = new Map(Object.entries(entries));
    return planLegacyLlmMigration((n) => m.has(n), (n) => m.get(n) ?? '');
  };
  const legacy = mk({ LLM_PROVIDER: 'gemini', LLM_API_KEY: 'k', LLM_BASE_URL: 'https://relay.example', LLM_BASE_URL_FORMAT: 'ai-sdk-prefix' });
  assert.deepEqual(legacy, [
    ['LLM_GEMINI_API_KEY', 'k'],
    ['LLM_GEMINI_BASE_URL', 'https://relay.example'],
  ], '纯遗留元组迁给当前厂商');
  // The mine that has been stepped on on site: The user has been assigned gemini exclusive key, and then moving to legacy base will quietly redirect the request to the old transit
  assert.deepEqual(mk({
    LLM_PROVIDER: 'gemini', LLM_GEMINI_API_KEY: 'own-key',
    LLM_API_KEY: 'k', LLM_BASE_URL: 'https://relay.example', LLM_BASE_URL_FORMAT: 'ai-sdk-prefix',
  }), [], '厂商已有专属配置 → 迁移整体跳过(base 落预设)');
  assert.deepEqual(mk({ LLM_PROVIDER: 'minimax' }), [], '无遗留值 → 空计划');
}

// ── mergeEnvText: update in place, preserve comment/blank/unrelated, append new ──
const out1 = mergeEnvText('# c\nLLM_API_KEY=old\n\nOTHER=keep\n', new Map([['LLM_API_KEY', 'new'], ['PEXELS_API_KEY', 'px']]));
assert.ok(out1.includes('LLM_API_KEY=new') && !out1.includes('LLM_API_KEY=old'), 'updates in place');
assert.ok(out1.includes('# c') && out1.includes('OTHER=keep'), 'preserves comment + unrelated var');
assert.ok(out1.split('\n').includes(''), 'preserves blank line');
assert.ok(out1.includes('PEXELS_API_KEY=px'), 'appends a genuinely-new key');

// ── mergeEnvText: empty value clears that line, others untouched; single trailing newline ──
const out2 = mergeEnvText('LLM_API_KEY=x\nE2B_API_KEY=y\n', new Map([['E2B_API_KEY', '']]));
assert.ok(!out2.includes('E2B_API_KEY') && out2.includes('LLM_API_KEY=x'), 'clears on empty value, keeps others');
assert.ok(out2.endsWith('\n') && !out2.endsWith('\n\n'), 'exactly one trailing newline');

// ── generation-service BASE_URLs are whitelisted and writable via the merge path ──
const BASE_URL_NAMES = ['ELEVENLABS_BASE_URL', 'DOUBAO_TTS_BASE_URL', 'MUREKA_BASE_URL', 'SEEDANCE_BASE_URL', 'KLING_BASE_URL'] as const;
for (const name of BASE_URL_NAMES) {
  assert.ok((KEY_NAMES as readonly string[]).includes(name), `${name} is whitelisted (settable via POST /api/keys)`);
}
const out3 = mergeEnvText('', new Map(BASE_URL_NAMES.map((n) => [n, `https://relay.example/${n.toLowerCase()}`])));
for (const name of BASE_URL_NAMES) {
  assert.ok(out3.includes(`${name}=https://relay.example/${name.toLowerCase()}`), `${name} written to .env text`);
}

// ── envLine quoting: values dotenv would mangle (inline # / fully quote-wrapped) get re-quoted ──
const out4 = mergeEnvText('', new Map([
  ['LLM_API_KEY', 'ab#cd'],           // unquoted # would be read back as inline comment
  ['E2B_TEMPLATE', '"wrapped"'],      // unquoted would have its quotes stripped on read
  ['PEXELS_API_KEY', 'plain-key'],    // stays unquoted
]));
assert.ok(out4.includes('LLM_API_KEY="ab#cd"'), 'value with # gets double-quoted');
assert.ok(out4.includes('E2B_TEMPLATE=\'"wrapped"\''), 'quote-wrapped value re-quoted with the other quote char');
assert.ok(out4.includes('PEXELS_API_KEY=plain-key'), 'plain value stays unquoted');

// ── seed + status: booleans + source only, and the derived caps — NEVER a key value ──
seedKeystore({ ...isolatedSeed, LLM_API_KEY: 'secret-abc', PEXELS_API_KEY: 'px-1' } as Record<string, string>);
const st = keyStatus();
assert.equal(st.keys.LLM_API_KEY.configured, true, 'seeded key marked configured');
assert.equal(st.keys.LLM_API_KEY.source, 'env', 'seeded key sourced from env');
assert.equal(st.keys.MUREKA_API_KEY.configured, false, 'unseeded key not configured');
assert.equal(st.keys.MUREKA_API_KEY.source, 'none', 'unseeded key source none');
assert.equal(st.caps.stock, true, 'pexels key → stock capability on');
assert.equal(st.caps.music, false, 'no mureka key → music capability off');
const serialized = JSON.stringify(st);
assert.ok(!serialized.includes('secret-abc') && !serialized.includes('px-1'), 'status leaks NO key value to the browser');
assert.equal(getKey('LLM_API_KEY'), 'secret-abc', 'getKey returns the live value server-side');

// ── non-secret model/routing/toggle channel: explicit routing names + per-vendor
// Base URL/model name (derived with LLM_PROVIDER_PRESETS), the value is echoed by keyStatus().models —
// The SECRET value still never appears in any response ──
const MODEL_ROUTING_NAMES = [
  'LLM_PROVIDER', 'LLM_MODEL', 'LLM_OPENAI_API_MODE',
  'GEMINI_IMAGE_MODEL', 'ELEVENLABS_TTS_MODEL', 'ELEVENLABS_SOUND_MODEL',
  'DOUBAO_TTS_RESOURCE_ID', 'SEEDANCE_VIDEO_MODEL', 'KLING_VIDEO_MODEL', 'MUREKA_MUSIC_MODEL',
  'MINIMAX_TTS_MODEL', 'MINIMAX_VIDEO_MODEL', 'MINIMAX_MUSIC_MODEL', 'MINIMAX_IMAGE_MODEL',
  'PREFERRED_IMAGE_VENDOR', 'PREFERRED_VOICE_VENDOR', 'PREFERRED_VIDEO_VENDOR', 'PREFERRED_MUSIC_VENDOR',
  'R2_ENABLED', // Cloud synchronization switch (''=enable/'0'=disable)
  'R2_PRESIGN', // Browser pre-signed direct transmission (''=enabled/'0'=server-side write-through only)
  'MEDIA_DIR',  // Asset saving directory (''=default public/media/uploads)
] as const;
for (const name of MODEL_ROUTING_NAMES) {
  assert.ok((KEY_NAMES as readonly string[]).includes(name), `${name} is whitelisted (settable via POST /api/keys)`);
  assert.ok(NON_SECRET_NAMES.has(name), `${name} is marked non-secret`);
}
const EXPECTED_NON_SECRET = new Set<string>([
  ...MODEL_ROUTING_NAMES,
  ...LLM_PROVIDER_PRESETS.flatMap((preset) => {
    const names = llmProviderConfigNames(preset.id);
    for (const name of Object.values(names)) {
      assert.ok((KEY_NAMES as readonly string[]).includes(name), `${name} is whitelisted`);
    }
    return [names.baseUrl, names.model];
  }),
]);
assert.deepStrictEqual(
  new Set(NON_SECRET_NAMES), EXPECTED_NON_SECRET,
  'NON_SECRET_NAMES = 显式路由/开关/路径名 + 每厂商 Base URL/模型名,不多不少(API Key 永不入内)',
);

// seed one SECRET + one non-secret on top of the state above (seeds accumulate in-process)
seedKeystore({ ...isolatedSeed, LLM_API_KEY: 'sec-x', MINIMAX_TTS_MODEL: 'speech-2.8-hd' } as Record<string, string>);
const st2 = keyStatus();
assert.equal(st2.models['MINIMAX_TTS_MODEL'], 'speech-2.8-hd', 'non-secret model value echoed in models');
assert.equal(st2.models['KLING_VIDEO_MODEL'], '', 'unset non-secret name echoes empty string');
assert.ok(!('LLM_API_KEY' in st2.models), 'SECRET key has no field in models at all');
assert.equal(st2.keys.LLM_API_KEY.configured, true, 'SECRET key still reported as configured boolean');
assert.ok(!JSON.stringify(st2).includes('sec-x'), 'SECRET value appears NOWHERE in the serialized status');

console.log('keystore.verify: ok');
