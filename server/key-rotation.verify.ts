// Multi-key rotation unit checks. node:test via tsx (matches the rest of the
// verify chain). Covers pool parsing, fail-over selection, cooldown parking,
// masked-status for the UI, and the {rm,add} mutation the settings UI sends.
// All exercises run against the in-memory keystore (seedKeystore) — no .env.local
// file is touched.
import assert from 'node:assert/strict';
import { seedKeystore, getKey, __resetKeystore } from './keystore.ts';
import {
  ROTATABLE, applyPoolMutation, getPool, markRateLimited, markRateLimitedByValue,
  parsePoolMutation, parsePoolValue, peekActiveKey, pickKey, poolStatus, shouldFailover,
  __resetRotationState,
} from './key-rotation.ts';

let passed = 0;
const ok = (name: string): void => { passed++; console.log(`  ✓ ${name}`); };

// Every sub-test starts from a clean rotation state + a freshly seeded keystore.
function setup(env: Record<string, string>): void {
  __resetRotationState();
  __resetKeystore();
  seedKeystore(env);
}

console.log('key-rotation.verify');

// ── parsePoolValue ──────────────────────────────────────────────────────────
{
  assert.deepEqual(parsePoolValue('["a","b","c"]'), ['a', 'b', 'c'], 'json array parses');
  assert.deepEqual(parsePoolValue('[" a ","b","a"]'), ['a', 'b'], 'trims + dedupes');
  assert.deepEqual(parsePoolValue('[]'), [], 'empty array');
  assert.deepEqual(parsePoolValue(''), [], 'empty string');
  assert.deepEqual(parsePoolValue('not json'), [], 'malformed → []');
  assert.deepEqual(parsePoolValue('"a string"'), [], 'non-array → []');
  assert.deepEqual(parsePoolValue('[1,2]'), [], 'non-string elements dropped → []');
  ok('parsePoolValue');
}

// ── getPool + legacy fallback ───────────────────────────────────────────────
{
  setup({ ASSEMBLYAI_API_KEYS: '["k1","k2"]' });
  assert.deepEqual(getPool('ASSEMBLYAI'), ['k1', 'k2'], 'pool read');
  // Legacy single key is used as a 1-element pool when the pool env is empty.
  setup({ ASSEMBLYAI_API_KEY: 'legacy-key' });
  assert.deepEqual(getPool('ASSEMBLYAI'), ['legacy-key'], 'legacy single fallback');
  setup({});
  assert.deepEqual(getPool('ASSEMBLYAI'), [], 'unconfigured → []');
  ok('getPool + legacy fallback');
}

// ── pickKey fail-over ───────────────────────────────────────────────────────
{
  setup({ PEXELS_API_KEYS: '["p0","p1","p2"]' });
  const first = pickKey('PEXELS');
  assert.equal(first?.index, 0, 'first pick = index 0');
  assert.equal(first?.key, 'p0');
  // Park key 0 → next pick must skip it (fail-over) without waiting real time.
  markRateLimited('PEXELS', 0);
  const second = pickKey('PEXELS');
  assert.equal(second?.index, 1, 'rate-limited key skipped');
  assert.equal(second?.key, 'p1');
  // Park key 1 too → pick wraps to a still-healthy key (index 2).
  markRateLimited('PEXELS', 1);
  const third = pickKey('PEXELS');
  assert.equal(third?.index, 2, 'wraps to next healthy');
  // Park EVERY key → fail OPEN: still returns a key (the soonest-deadline one).
  markRateLimited('PEXELS', 2);
  const allCooling = pickKey('PEXELS');
  assert.ok(allCooling, 'fail-open returns a key even when all cooling');
  ok('pickKey fail-over + fail-open');
}

// ── peekActiveKey is non-advancing ──────────────────────────────────────────
{
  setup({ PEXELS_API_KEYS: '["p0","p1"]' });
  const a = peekActiveKey('PEXELS');
  const b = peekActiveKey('PEXELS');
  assert.equal(a, b, 'peek does not advance');
  assert.equal(a, 'p0', 'peek returns the active key');
  // peek must not disturb a subsequent pickKey's starting point.
  const picked = pickKey('PEXELS');
  assert.equal(picked?.index, 0, 'pick still starts at 0 after peeks');
  ok('peekActiveKey non-advancing');
}

// ── poolStatus (masked, no values) ──────────────────────────────────────────
{
  setup({ ASSEMBLYAI_API_KEYS: '["abcdefgh","xy"]' });
  pickKey('ASSEMBLYAI');  // activeIndex = 0
  markRateLimited('ASSEMBLYAI', 0);  // park key 0
  const status = poolStatus('ASSEMBLYAI');
  assert.equal(status.count, 2, 'count');
  assert.equal(status.keys[0]?.suffix, '…efgh', 'long key masked to last 4');
  assert.equal(status.keys[1]?.suffix, '…', 'short key → ellipsis only');
  assert.equal(status.keys[0]?.status, 'cooldown', 'parked key = cooldown');
  assert.equal(status.keys[1]?.status, 'active', 'healthy key = active');
  assert.ok((status.keys[0]?.cooldownSeconds ?? 0) > 0, 'cooldown has remaining seconds');
  // No raw value ever leaks into the status object.
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes('abcdefgh') && !serialized.includes('"xy"'),
    'no raw key value in poolStatus');
  ok('poolStatus masking + status');
}

// ── shouldFailover ──────────────────────────────────────────────────────────
{
  assert.equal(shouldFailover('ASSEMBLYAI', 429), true, '429 triggers');
  assert.equal(shouldFailover('ASSEMBLYAI', 402), true, '402 triggers');
  assert.equal(shouldFailover('ASSEMBLYAI', 200), false, '200 does not');
  assert.equal(shouldFailover('ASSEMBLYAI', 500), false, '500 does not');
  ok('shouldFailover');
}

// ── parsePoolMutation ───────────────────────────────────────────────────────
{
  const m = parsePoolMutation('{"rm":[0,2],"add":["new"]}');
  assert.deepEqual(m?.rm, [0, 2], 'rm parsed');
  assert.deepEqual(m?.add, ['new'], 'add parsed');
  assert.equal(parsePoolMutation(''), null, 'empty → null');
  assert.equal(parsePoolMutation('not json'), null, 'malformed → null');
  assert.equal(parsePoolMutation('["a"]'), null, 'array (not mutation) → null');
  assert.equal(parsePoolMutation('{}')?.rm.length, 0, 'empty object → empty mutation');
  // Negative / non-integer / non-number rm entries are filtered; 3 is valid so kept.
  const dirty = parsePoolMutation('{"rm":[-1,1.5,"x",3],"add":[1,true,"k"]}');
  assert.deepEqual(dirty?.rm, [3], 'only valid non-negative int rm kept');
  assert.deepEqual(dirty?.add, ['k'], 'non-string add dropped');
  ok('parsePoolMutation');
}

// ── applyPoolMutation ───────────────────────────────────────────────────────
{
  // remove index 1 + append d → [a, c, d]
  let next = applyPoolMutation('["a","b","c"]', [1], ['d']);
  assert.deepEqual(JSON.parse(next), ['a', 'c', 'd'], 'rm + add');
  // out-of-range rm ignored
  next = applyPoolMutation('["a","b"]', [9], []);
  assert.deepEqual(JSON.parse(next), ['a', 'b'], 'oob rm ignored');
  // add dedupes against existing
  next = applyPoolMutation('["a"]', [], ['a', 'b']);
  assert.deepEqual(JSON.parse(next), ['a', 'b'], 'dedup add vs existing');
  // empty result → ''
  next = applyPoolMutation('["a"]', [0], []);
  assert.equal(next, '', 'emptied → ""');
  // add trims + drops blanks
  next = applyPoolMutation('[]', [], ['  x  ', '']);
  assert.deepEqual(JSON.parse(next), ['x'], 'add trimmed + blanks dropped');
  ok('applyPoolMutation');
}

// ── setKeys path round-trips to the canonical pool ──────────────────────────
// Confirms the keystore-level integration: a mutation JSON applied via the
// keystore produces a pool that getPool can read back.
{
  setup({ PEXELS_API_KEYS: '["orig"]' });
  const stored = applyPoolMutation(getKey('PEXELS_API_KEYS'), [], ['second']);
  seedKeystore({ PEXELS_API_KEYS: stored });
  assert.deepEqual(getPool('PEXELS'), ['orig', 'second'], 'mutation persisted + readable');
  ok('mutation → getPool round-trip');
}

// ── regression: removing a key must NOT shift its cooldown onto a neighbor ──
// (was a positional-array bug; cooldowns are now keyed by value.) The rotation
// state persists across a pool edit (as it does when the user saves a removal
// while a key is cooling) — A's cooldown must disappear WITH A, not land on B.
{
  __resetKeystore(); __resetRotationState();
  seedKeystore({ PEXELS_API_KEYS: '["aaa111","bbb222","ccc333"]' });
  pickKey('PEXELS');              // lastPickedKey = aaa111
  markRateLimited('PEXELS', 0);   // park aaa111
  const before = poolStatus('PEXELS');
  assert.equal(before.keys[0]?.status, 'cooldown', 'aaa111 parked');
  assert.equal(before.keys[1]?.status, 'active', 'bbb222 healthy before removal');
  // Simulate the user removing aaa111 (pool → [bbb222, ccc333]); rotation state persists.
  seedKeystore({ PEXELS_API_KEYS: '["bbb222","ccc333"]' });
  const after = poolStatus('PEXELS');
  assert.equal(after.count, 2, 'pool shrunk');
  assert.equal(after.keys[0]?.suffix, '…b222', 'slot 0 is now bbb222');
  assert.equal(after.keys[0]?.status, 'active', 'bbb222 NOT mis-attributed aaa111 cooldown');
  assert.equal(after.keys[1]?.status, 'active', 'ccc333 healthy');
  ok('remove key keeps its own cooldown (value-keyed)');
}

// ── markRateLimitedByValue (stock-plugin seam) ──────────────────────────────
{
  __resetKeystore(); __resetRotationState();
  seedKeystore({ ASSEMBLYAI_API_KEYS: '["a1","a2"]' });
  pickKey('ASSEMBLYAI');  // a1
  markRateLimitedByValue('ASSEMBLYAI', 'a1');
  const next = pickKey('ASSEMBLYAI');
  assert.equal(next?.key, 'a2', 'by-value park advances to a2');
  // A literal value not in the pool is a no-op (test fixtures pass literals).
  const before = poolStatus('ASSEMBLYAI').keys.map((k) => k.status);
  markRateLimitedByValue('ASSEMBLYAI', 'not-in-pool');
  const afterStatus = poolStatus('ASSEMBLYAI').keys.map((k) => k.status);
  assert.deepEqual(afterStatus, before, 'unknown value is a no-op');
  ok('markRateLimitedByValue');
}

// ── ROTATABLE registry sanity ───────────────────────────────────────────────
{
  const ids = ROTATABLE.map((p) => p.id);
  assert.deepEqual(ids, ['ASSEMBLYAI', 'PEXELS', 'PIXABAY', 'UNSPLASH', 'FREESOUND', 'DVIDS'],
    'all 6 assets providers registered');
  for (const p of ROTATABLE) {
    assert.ok(p.secretPool.endsWith('_KEYS') || p.secretPool.endsWith('_ACCESS_KEYS'),
      `${p.id} pool env named correctly`);
    assert.deepEqual(p.triggerStatus, [429, 402], `${p.id} triggers on 429/402`);
  }
  ok('ROTATABLE registry');
}

console.log(`key-rotation.verify … OK (${passed})`);
