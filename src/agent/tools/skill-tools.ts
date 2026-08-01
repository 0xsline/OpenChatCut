export { SKILL_TOOL_SCHEMAS, SKILL_TOOL_NAMES } from './schemas/skill-tools';
import type { AgentContext } from '../context';
import { CREATIVE_SKILLS, findSkill, setCustomSkills } from '../skills/skills-catalog';
import { parseSkillFrontmatter } from '../skills/skill-frontmatter';
import type { SkillDefinition } from '../skills/skill-types';
import { listCustomSkills, saveCustomSkill, deleteCustomSkill, type CustomSkill } from '../../persist/skillStore';

// manage_skill maintains selectable custom skills. Skill bodies are resolved by
// load_skill after selection; built-in skills remain read-only.

type Args = Record<string, unknown>;

const strArg = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : [];
const isBuiltin = (id: string): boolean => CREATIVE_SKILLS.some((s) => s.id === id);
const brief = (skill: SkillDefinition) => ({
  id: skill.id,
  slug: skill.slug,
  name: skill.name,
  nameZh: skill.nameZh,
  summary: skill.summary,
  scenarios: skill.scenarios,
});

/** Reread custom skills from the IDB and synchronize the in-memory registry, making them immediately fresh within findSkill/drop sessions. */
async function refresh(): Promise<CustomSkill[]> {
  const list = await listCustomSkills();
  setCustomSkills(list);
  return list;
}

async function doList(ctx: AgentContext): Promise<unknown> {
  const custom = await refresh();
  return { builtin: CREATIVE_SKILLS.map(brief), custom: custom.map(brief), activeSkillId: ctx.getCreativeMode() };
}

/** Currently activated creative mode. Its body is loaded separately through load_skill. */
async function doCurrent(ctx: AgentContext): Promise<unknown> {
  const id = ctx.getCreativeMode();
  if (!id) return { active: null, note: '当前未选创作模式。' };
  await refresh().catch(() => []); // Custom skills need to re-read the registry; node checks the environment and skips silently if there is no IDB.
  const s = findSkill(id);
  if (!s) return { active: { id }, note: '该技能定义已被删除,模式仍挂着旧 id;可 activate 换一个或传空串清除。' };
  return { active: { ...brief(s), builtin: isBuiltin(id) } };
}

/** Switch/clear the creative mode (chat-level status, effective immediately, no undo; text is injected from the next message). */
async function doActivate(args: Args, ctx: AgentContext): Promise<unknown> {
  if (!ctx.setCreativeMode) return { error: 'this host cannot switch creative mode' };
  const id = strArg(args.skillId);
  if (!id) {
    ctx.setCreativeMode(null);
    return { ok: true, active: null, note: '已清除创作模式。' };
  }
  await refresh().catch(() => []);
  const s = findSkill(id);
  if (!s) return { error: `no skill "${id}"; use list to see available ids` };
  ctx.setCreativeMode(id);
  return { ok: true, active: { ...brief(s), builtin: isBuiltin(id) }, note: '已切换;下一条消息会先按需加载该技能正文。' };
}

async function doGet(args: Args): Promise<unknown> {
  const id = strArg(args.skillId);
  if (!id) return { error: 'get requires "skillId"' };
  await refresh(); // Allow findSkill to parse custom ids
  const s = findSkill(id);
  if (!s) return { error: `no skill "${id}"` };
  return { skill: { ...brief(s), body: s.body, builtin: isBuiltin(id) } };
}

async function doCreate(args: Args): Promise<unknown> {
  const name = strArg(args.name);
  const body = strArg(args.body);
  if (!name) return { error: 'create requires a non-empty "name"' };
  if (!body) return { error: 'create requires a non-empty "body"' };
  const id = `skill_${crypto.randomUUID()}`;
  const summary = strArg(args.summary) || name;
  const parsed = parseSkillFrontmatter(body);
  const skill: CustomSkill = {
    id,
    slug: /^[A-Za-z0-9_-]+$/.test(parsed.name) ? parsed.name : id,
    name,
    nameZh: name,
    description: summary,
    summary,
    scenarios: strArr(args.scenarios),
    body,
    files: [],
    source: 'custom',
    createdAt: Date.now(),
  };
  await saveCustomSkill(skill);
  await refresh();
  return { ok: true, created: brief(skill) };
}

async function doUpdate(args: Args): Promise<unknown> {
  const id = strArg(args.skillId);
  if (!id) return { error: 'update requires "skillId"' };
  if (isBuiltin(id)) return { error: 'cannot edit a built-in skill; create a custom one instead' };
  const existing = (await listCustomSkills()).find((s) => s.id === id);
  if (!existing) return { error: `no custom skill "${id}"` };
  const name = strArg(args.name);
  const body = strArg(args.body);
  const summary = strArg(args.summary);
  const parsed = body ? parseSkillFrontmatter(body) : undefined;
  const slug = parsed && /^[A-Za-z0-9_-]+$/.test(parsed.name)
    ? parsed.name
    : existing.slug;
  // Immutable: Returns a new object, overwriting only explicitly given fields
  const next: CustomSkill = {
    ...existing,
    ...(name ? { name, nameZh: name } : {}),
    ...(body ? { body, slug } : {}),
    ...(summary ? { summary, description: summary } : {}),
    ...(args.scenarios !== undefined ? { scenarios: strArr(args.scenarios) } : {}),
  };
  await saveCustomSkill(next);
  await refresh();
  return { ok: true, updated: brief(next) };
}

async function doDelete(args: Args): Promise<unknown> {
  const id = strArg(args.skillId);
  if (!id) return { error: 'delete requires "skillId"' };
  if (isBuiltin(id)) return { error: 'cannot delete a built-in skill' };
  const existing = (await listCustomSkills()).find((s) => s.id === id);
  if (!existing) return { error: `no custom skill "${id}"` };
  await deleteCustomSkill(id);
  await refresh();
  return { ok: true, deleted: id };
}

// The skill library is global (not divided by project); the active state (creative mode) is the project-level chat state, which is read and written by ctx.
export async function execSkillTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'manage_skill') return { error: `unknown tool ${name}` };
  switch (String(args.action ?? '')) {
    case 'list': return doList(ctx);
    case 'get': return doGet(args);
    case 'current': return doCurrent(ctx);
    case 'activate': return doActivate(args, ctx);
    case 'create': return doCreate(args);
    case 'update': return doUpdate(args);
    case 'delete': return doDelete(args);
    default: return { error: `unknown action "${args.action}"; use list|get|current|activate|create|update|delete` };
  }
}
