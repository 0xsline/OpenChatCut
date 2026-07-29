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
    '自定义创作技能 = 一段可复用的创作模式指引(bodyMarkdown),与内置技能并列出现在「创作模式」下拉里,选中后注入系统提示,指导 AI 的规划与流程(不改变可用工具)。',
    'action: list | get | current | activate | create | update | delete.',
    'list = 列出全部技能(内置只读 + 自定义,各带 id/name/summary;附 activeSkillId)。',
    'get(带 skillId)= 查看某技能详情(含完整 body 正文;builtin 标记该技能是否内置)。',
    'current = 查看当前激活的创作模式(无则 active:null)。',
    'activate(带 skillId;传空串清除)= 切换本工程的创作模式——用户在表单卡里选定模式后用它替用户应用;指引正文自下一条消息起注入。',
    'create(带 name + body,可选 summary/scenarios)= 新建一个自定义技能并生成 id;name/body 必填非空。',
    'update(带 skillId + 要改的字段)= 修改一个自定义技能(只能改自定义,内置只读)。',
    'delete(带 skillId)= 删除一个自定义技能(只能删自定义,内置不可删)。',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'current', 'activate', 'create', 'update', 'delete'] },
      skillId: { type: 'string', description: 'get/update/delete/activate 的目标技能 id(用 list 先取);activate 传空串 = 清除创作模式。' },
      name: { type: 'string', description: 'create/update: 技能显示名(create 必填非空)。' },
      body: { type: 'string', description: 'create/update: 技能指引正文(Markdown,注入系统提示;create 必填非空)。' },
      summary: { type: 'string', description: 'create/update: 一句话描述(可选;create 缺省用 name)。' },
      scenarios: { type: 'array', items: { type: 'string' }, description: 'create/update: 触发场景关键词(可选)。' },
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
