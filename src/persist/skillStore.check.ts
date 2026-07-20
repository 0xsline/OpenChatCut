// Runnable check: `npx tsx src/persist/skillStore.check.ts`.
// Verifies custom-skill CRUD + the manage_skill tool boundaries (builtin is read-only).
// Node has no IndexedDB, so we install a tiny in-memory shim of the surface the
// store touches (open / transaction / objectStore.get|put|delete). tsx transpiles
// without typechecking, so the shim only needs to be runtime-correct.
import assert from 'node:assert';
import { loadCustomSkills, listCustomSkills, saveCustomSkill, deleteCustomSkill, type CustomSkill } from './skillStore';
import { execSkillTool } from '../agent/tools/skill-tools';
import { CREATIVE_SKILLS, findSkill } from '../agent/skills/skills-catalog';
import type { AgentContext } from '../agent/context';

type Cb = (() => void) | undefined;
interface FakeReq { result?: unknown; error?: unknown; onsuccess?: Cb; onerror?: Cb; onupgradeneeded?: Cb }
interface FakeTx { objectStore: () => FakeStore; oncomplete?: Cb; onerror?: Cb; error?: unknown }
interface FakeStore { get(k: string): FakeReq; put(v: unknown, k: string): FakeReq; delete(k: string): FakeReq }

// IDB fires its callbacks asynchronously (after the caller assigns onsuccess),
// so every handler is scheduled via queueMicrotask, never called inline.
function installIdbShim(): void {
  const data = new Map<string, unknown>();
  let created = false;
  const store: FakeStore = {
    get(key) { const req: FakeReq = {}; queueMicrotask(() => { req.result = data.get(key); req.onsuccess?.(); }); return req; },
    put(val, key) { data.set(key, val); const req: FakeReq = {}; queueMicrotask(() => req.onsuccess?.()); return req; },
    delete(key) { data.delete(key); const req: FakeReq = {}; queueMicrotask(() => req.onsuccess?.()); return req; },
  };
  const db = {
    createObjectStore: () => { created = true; return store; },
    transaction: (): FakeTx => { const tx: FakeTx = { objectStore: () => store }; queueMicrotask(() => tx.oncomplete?.()); return tx; },
  };
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open: () => { const req: FakeReq = { result: db }; queueMicrotask(() => { if (!created) req.onupgradeneeded?.(); req.onsuccess?.(); }); return req; },
  };
}

installIdbShim();

// ── store layer: create → list contains → delete → list no longer contains ──
const seed: CustomSkill = {
  id: 'skill_seed', name: 'Seed', nameZh: 'Seed', summary: 's', scenarios: ['a'],
  body: 'do the thing', builtin: false, createdAt: Date.now(),
};
await saveCustomSkill(seed);
assert.ok((await listCustomSkills()).some((s) => s.id === 'skill_seed'), 'create → list contains new skill');
await deleteCustomSkill('skill_seed');
assert.ok(!(await loadCustomSkills()).some((s) => s.id === 'skill_seed'), 'delete → list no longer contains it');

// ── tool layer (manage_skill) ── 库是全局的;ctx 只被 current/activate 用到,给最小桩
const ctx = { getCreativeMode: () => null, setCreativeMode: () => {} } as unknown as AgentContext;

const created = await execSkillTool('manage_skill', { action: 'create', name: 'Agent Skill', body: 'plan then execute' }, ctx) as { ok: boolean; created: { id: string } };
assert.ok(created.ok && created.created.id.startsWith('skill_'), 'create returns a generated id');

const listed = await execSkillTool('manage_skill', { action: 'list' }, ctx) as { builtin: unknown[]; custom: { id: string }[] };
assert.strictEqual(listed.builtin.length, 8, 'list includes the 8 built-ins');
assert.ok(listed.custom.some((s) => s.id === created.created.id), 'list includes the new custom skill');

const got = await execSkillTool('manage_skill', { action: 'get', skillId: created.created.id }, ctx) as { skill: { builtin: boolean; body: string } };
assert.strictEqual(got.skill.builtin, false, 'custom skill is flagged not-builtin');
assert.strictEqual(got.skill.body, 'plan then execute', 'get returns the full body');

// registry is hydrated by the tool → findSkill resolves the custom id synchronously
assert.strictEqual(findSkill(created.created.id)?.id, created.created.id, 'findSkill resolves custom id after tool mutation');

// boundary: built-ins are read-only
const builtinId = CREATIVE_SKILLS[0].id;
assert.ok((await execSkillTool('manage_skill', { action: 'delete', skillId: builtinId }, ctx) as { error?: string }).error, 'refuses to delete a built-in');
assert.ok((await execSkillTool('manage_skill', { action: 'update', skillId: builtinId, body: 'x' }, ctx) as { error?: string }).error, 'refuses to edit a built-in');
assert.strictEqual(findSkill(builtinId)?.id, builtinId, 'built-in still intact');

// boundary: create rejects empty name/body (LLM input is untrusted)
assert.ok((await execSkillTool('manage_skill', { action: 'create', name: '  ', body: 'x' }, ctx) as { error?: string }).error, 'create rejects empty name');
assert.ok((await execSkillTool('manage_skill', { action: 'create', name: 'ok', body: '  ' }, ctx) as { error?: string }).error, 'create rejects empty body');

// update touches only the given field, leaves the rest intact (immutable copy)
assert.ok((await execSkillTool('manage_skill', { action: 'update', skillId: created.created.id, summary: 'new summary' }, ctx) as { ok?: boolean }).ok, 'update ok');
const after = (await listCustomSkills()).find((s) => s.id === created.created.id)!;
assert.strictEqual(after.summary, 'new summary', 'summary updated');
assert.strictEqual(after.body, 'plan then execute', 'body untouched by partial update');

// delete the custom skill
await execSkillTool('manage_skill', { action: 'delete', skillId: created.created.id }, ctx);
assert.ok(!(await listCustomSkills()).some((s) => s.id === created.created.id), 'custom skill deleted');

console.log('skillStore.check: ok');
