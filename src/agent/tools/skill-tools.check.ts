// 可运行自检:`npx tsx src/agent/tools/skill-tools.check.ts`
// manage_skill 的 current / activate(创作模式 dump 与切换)契约:current 空/有值两态、
// activate 校验 id + 经 ctx.setCreativeMode 落地 + 空串清除、宿主未接 setter 的报错。
// 自定义技能 CRUD 走 IDB(浏览器专属),node 下 refresh 静默跳过——这里只用内置技能验证。
import assert from 'node:assert';
import { execSkillTool, SKILL_TOOL_NAMES, SKILL_TOOL_SCHEMAS } from './skill-tools';
import { CREATIVE_SKILLS } from '../skills/skills-catalog';
import type { AgentContext } from '../context';

assert.ok(SKILL_TOOL_NAMES.has('manage_skill'));
const actions = (SKILL_TOOL_SCHEMAS[0].input_schema as unknown as { properties: { action: { enum: string[] } } }).properties.action.enum;
for (const a of ['list', 'get', 'current', 'activate', 'create', 'update', 'delete']) {
  assert.ok(actions.includes(a), `schema 应含 action ${a}`);
}

// 假宿主:一个可读写的创作模式槽
let mode: string | null = null;
const ctx = {
  getCreativeMode: () => mode,
  setCreativeMode: (id: string | null) => { mode = id; },
} as unknown as AgentContext;

const builtinId = CREATIVE_SKILLS[0].id;

// ---- current:未选 → active:null ----
{
  const r = await execSkillTool('manage_skill', { action: 'current' }, ctx) as { active: unknown; note?: string };
  assert.strictEqual(r.active, null, '未选模式应回 active:null');
  assert.ok(r.note?.includes('未选'), '应带未选说明');
}

// ---- activate 内置技能 → 落地 + 回简介;current 读回同一个 ----
{
  const r = await execSkillTool('manage_skill', { action: 'activate', skillId: builtinId }, ctx) as {
    ok?: boolean; active?: { id: string; builtin: boolean }; note?: string;
  };
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.active?.id, builtinId);
  assert.strictEqual(r.active?.builtin, true, '内置技能应标 builtin');
  assert.ok(r.note?.includes('下一条消息'), '应说明注入时机(system 每次 runAgent 构建一次)');
  assert.strictEqual(mode, builtinId, 'ctx.setCreativeMode 应被调用');

  const cur = await execSkillTool('manage_skill', { action: 'current' }, ctx) as { active: { id: string } };
  assert.strictEqual(cur.active.id, builtinId, 'current 应读回激活的模式');
}

// ---- activate 未知 id → 报错且不动现状 ----
{
  const r = await execSkillTool('manage_skill', { action: 'activate', skillId: 'skill_nope' }, ctx) as { error?: string };
  assert.ok(r.error?.includes('no skill'), '未知 id 应报错');
  assert.strictEqual(mode, builtinId, '报错不应改动当前模式');
}

// ---- activate 空串 → 清除 ----
{
  const r = await execSkillTool('manage_skill', { action: 'activate', skillId: '' }, ctx) as { ok?: boolean; active?: unknown };
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.active, null);
  assert.strictEqual(mode, null, '空串应清除模式');
}

// ---- 宿主未接 setter(旧 check 形制的 ctx)→ 明确报错 ----
{
  const bare = { getCreativeMode: () => null } as unknown as AgentContext;
  const r = await execSkillTool('manage_skill', { action: 'activate', skillId: builtinId }, bare) as { error?: string };
  assert.ok(r.error, '无 setCreativeMode 的宿主应报错而非静默');
}

console.log('skill-tools.check: ALL PASSED');
