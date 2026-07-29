import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import { CREATIVE_SKILLS, findSkill, setCustomSkills, type CreativeSkill } from '../skills/skills-catalog';
import { listCustomSkills, saveCustomSkill, deleteCustomSkill, type CustomSkill } from '../../persist/skillStore';

// manage_skill — Custom creation skills (in-app agent unique tool,
// parallel to track_progress). Skill = a creative mode guide (bodyMarkdown), which injects system prompts after selection.
// action: list (built-in + custom columns)/ get (view the text of a skill)/ create (new custom)/
// update (change customization)/delete (delete customization).
// Boundary: LLM input is not trustworthy - name/body non-empty verification; only customization can be changed/delete, and built-in skills are read-only.
// After mutation, setCustomSkills(await listCustomSkills()) synchronizes the memory registry and lets findSkill/drop-down
// See changes immediately within the session. Determination and undo are driven by UI selections, and the tool itself only maintains a library of skills.

type Args = Record<string, unknown>;

export const SKILL_TOOL_SCHEMAS: AgentToolSchema[] = [{
  name: 'manage_skill',
  description: [
    'A custom creative skill is reusable workflow guidance in bodyMarkdown. It appears beside built-in skills in the Creative Mode picker and, when selected, is injected into the system prompt to guide planning and execution without changing available tools.',
    'action: list | get | current | activate | create | update | delete.',
    'list returns all read-only built-in and custom skills with id/name/summary plus activeSkillId.',
    'get with skillId returns details including the full body and a builtin flag.',
    'current returns the active creative mode or active:null.',
    'activate with skillId switches the project creative mode; pass an empty string to clear it. Use this after the user selects a mode in a form card. Its body is injected starting with the next message.',
    'create with name + body and optional summary/scenarios creates a custom skill and id; name/body must be non-empty.',
    'update with skillId and changed fields edits a custom skill; built-ins are read-only.',
    'delete with skillId removes a custom skill; built-ins cannot be deleted.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'current', 'activate', 'create', 'update', 'delete'] },
      skillId: { type: 'string', description: 'Target skill id for get/update/delete/activate; call list first. Pass an empty string to activate to clear Creative Mode.' },
      name: { type: 'string', description: 'create/update: display name; required and non-empty for create.' },
      body: { type: 'string', description: 'create/update: Markdown instructions injected into the system prompt; required and non-empty for create.' },
      summary: { type: 'string', description: 'create/update: optional one-line description; create defaults to name.' },
      scenarios: { type: 'array', items: { type: 'string' }, description: 'create/update: optional trigger-scenario keywords.' },
    },
    required: ['action'],
  },
}];

export const SKILL_TOOL_NAMES = new Set(SKILL_TOOL_SCHEMAS.map((t) => t.name));

const strArg = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : [];
const isBuiltin = (id: string): boolean => CREATIVE_SKILLS.some((s) => s.id === id);
const brief = (s: CreativeSkill) => ({ id: s.id, name: s.name, nameZh: s.nameZh, summary: s.summary, scenarios: s.scenarios });

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

/** Currently activated creative mode (dump): The text has been injected into the system prompts. Here is the introduction for self-examination/continuation of chat positioning. */
async function doCurrent(ctx: AgentContext): Promise<unknown> {
  const id = ctx.getCreativeMode();
  if (!id) return { active: null, note: '当前未选创作模式(系统提示无技能指引注入)。' };
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
  return { ok: true, active: { ...brief(s), builtin: isBuiltin(id) }, note: '已切换;该模式的指引正文自下一条消息起注入系统提示。' };
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
  const skill: CustomSkill = {
    id: `skill_${crypto.randomUUID()}`,
    name,
    nameZh: name, // Custom skills have the same name in Chinese and English (the user only gives one name)
    summary: strArg(args.summary) || name,
    scenarios: strArr(args.scenarios),
    body,
    builtin: false,
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
  // Immutable: Returns a new object, overwriting only explicitly given fields
  const next: CustomSkill = {
    ...existing,
    ...(name ? { name, nameZh: name } : {}),
    ...(body ? { body } : {}),
    ...(summary ? { summary } : {}),
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
