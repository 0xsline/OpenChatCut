// capabilities.verify.ts — mode-aware provider routing: on/off partition, fallback
// (no vite define) fallback of the configured-capabilities manifest.
//   npx tsx src/agent/capabilities.verify.ts
import assert from 'node:assert/strict';
import { applyLiveKeyStatus, applyLiveModels, capabilitiesPrompt, CONFIGURED_CAPS, type CapabilityKey } from './capabilities';

const ALL_OFF: Record<CapabilityKey, boolean> = {
  image: false, voice: false, video: false, music: false, sound: false,
  stock: false, transcription: false, sandbox: false, web: false,
};

// ── all-off: every gated tool listed as 未配置, none marked available ──
const off = capabilitiesPrompt(ALL_OFF);
assert.ok(off.includes('submit_image') && off.includes('submit_voice') && off.includes('run_code'), 'lists gated tools');
assert.ok(off.includes('(no key-gated capabilities)'), 'no capability marked available when all off');
assert.ok(off.includes('push_asset'), 'includes a fallback hint for an off capability');

// ── mixed: image + transcription on → they sit in the ✅ section, voice in the ⬜ section ──
const mixed = capabilitiesPrompt({ ...ALL_OFF, image: true, transcription: true });
const onIdx = mixed.indexOf('✅');
const offIdx = mixed.indexOf('⬜');
assert.ok(onIdx >= 0 && offIdx > onIdx, 'both sections present, ✅ before ⬜');
const onLine = mixed.slice(onIdx, offIdx);
assert.ok(onLine.includes('submit_image') && onLine.includes('transcribe_track'), 'configured caps in ✅ section');
assert.ok(!onLine.includes('submit_voice'), 'unconfigured cap NOT in ✅ section');
assert.ok(mixed.slice(offIdx).includes('submit_voice'), 'unconfigured cap in ⬜ section');

// ── vendor granularity + routing semantics ──
// single configured vendor → named with its tool arg and "直接用"
applyLiveKeyStatus({ KLING_API_KEY: { configured: true } });
const vendored = capabilitiesPrompt({ ...ALL_OFF, video: true });
assert.ok(vendored.includes('Kling(model=kling) — use it directly'), 'single vendor → use directly');
assert.ok(!vendored.includes('seedance2'), 'unconfigured vendor NOT listed');

// one minimax key lights all its vendor rows
applyLiveKeyStatus({ MINIMAX_API_KEY: { configured: true } });
const mm = capabilitiesPrompt({ ...ALL_OFF, video: true, image: true, voice: true, music: true });
assert.ok(mm.includes('Hailuo(model=hailuo)') && mm.includes('MiniMax(model=image-01)')
  && mm.includes('MiniMax(provider=minimax)'), 'one minimax key lights all its vendor rows');

// AND-group: doubao needs both keys
applyLiveKeyStatus({ DOUBAO_TTS_APP_ID: { configured: true } });
const half = capabilitiesPrompt({ ...ALL_OFF, voice: true });
assert.ok(!half.includes('Doubao(provider=doubao)'), 'AND-group (doubao needs both keys) not satisfied by one');

// several vendors + NO user default → agent must ask before first use
applyLiveKeyStatus({ KLING_API_KEY: { configured: true }, SEEDANCE_API_KEY: { configured: true } });
applyLiveModels({});
const askFirst = capabilitiesPrompt({ ...ALL_OFF, video: true });
assert.ok(askFirst.includes('ask_followup_questions'), 'no default + several vendors → ask the user first');
assert.ok(askFirst.includes('Seedance(model=seedance2)') && askFirst.includes('Kling(model=kling)'), 'options listed');

// user default set → use it, never ask
applyLiveModels({ PREFERRED_VIDEO_VENDOR: 'kling' });
const preferred = capabilitiesPrompt({ ...ALL_OFF, video: true });
assert.ok(preferred.includes('user default: Kling(model=kling) — use it without asking again'), 'user default honored');
assert.ok(!preferred.includes('ask_followup_questions'), 'no ask when default set');

// default points at an UNCONFIGURED vendor → falls back to ask (not blindly honored)
applyLiveModels({ PREFERRED_VIDEO_VENDOR: 'hailuo' });
const stalePref = capabilitiesPrompt({ ...ALL_OFF, video: true });
assert.ok(stalePref.includes('ask_followup_questions'), 'default for unconfigured vendor → ask instead');

// several vendors + AUTO mode (user delegated) → agent picks freely, no forced ask
applyLiveKeyStatus({ KLING_API_KEY: { configured: true }, SEEDANCE_API_KEY: { configured: true } });
applyLiveModels({});
const autoMode = capabilitiesPrompt({ ...ALL_OFF, video: true }, 'auto');
assert.ok(!autoMode.includes('ask_followup_questions'), 'auto mode → no forced ask before first use');
assert.ok(autoMode.includes('pick the most suitable one yourself'), 'auto mode → agent picks and states the reason');

// several vendors + MANUAL mode → still asks (regression)
const manualMode = capabilitiesPrompt({ ...ALL_OFF, video: true }, 'manual');
assert.ok(manualMode.includes('ask_followup_questions'), 'manual mode → ask before first use');

// the provider-choice rule names the routing ladder and pins choice to the list
assert.ok(autoMode.includes('user default → single provider → ask once in manual mode → pick freely in auto mode'),
  'provider-choice rule documents the routing ladder');
assert.ok(autoMode.includes('Never use a provider that is not in the list above'), 'choice pinned to configured list');
assert.ok(autoMode.includes('guide them to Settings'), 'unconfigured capability points to Settings');

// ── tsx (no vite define): CONFIGURED_CAPS falls back to all-false without throwing ──
assert.equal(typeof CONFIGURED_CAPS.image, 'boolean', 'CONFIGURED_CAPS resolves under tsx (all-false fallback, no ReferenceError)');
assert.equal(CONFIGURED_CAPS.image, false, 'fallback is all-false outside Vite');

console.log('capabilities.verify: ok');
