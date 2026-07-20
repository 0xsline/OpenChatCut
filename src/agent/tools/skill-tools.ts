import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from '../context';
import { CREATIVE_SKILLS, findSkill, setCustomSkills, type CreativeSkill } from '../skills/skills-catalog';
import { listCustomSkills, saveCustomSkill, deleteCustomSkill, type CustomSkill } from '../../persist/skillStore';

// manage_skill — 自定义创作技能(in-app agent 独有工具,
// 与 track_progress 并列)。技能 = 一段创作模式指引(bodyMarkdown),选中后注入系统提示。
// action: list(内置+自定义都列)/ get(查看某技能正文)/ create(新建自定义)/
// update(改自定义)/ delete(删自定义)。
// 边界:LLM 输入不可信——name/body 非空校验;只能改/删自定义,内置技能只读。
// mutation 后 setCustomSkills(await listCustomSkills()) 同步内存注册表,让 findSkill/下拉
// 会话内立即看到变化。确定性与撤销由 UI 选中驱动，工具本身只维护技能库。

type Args = Record<string, unknown>;

export const SKILL_TOOL_SCHEMAS: Anthropic.Tool[] = [{
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

/** 从 IDB 重读自定义技能并同步内存注册表,让 findSkill/下拉会话内立即新鲜。 */
async function refresh(): Promise<CustomSkill[]> {
  const list = await listCustomSkills();
  setCustomSkills(list);
  return list;
}

async function doList(ctx: AgentContext): Promise<unknown> {
  const custom = await refresh();
  return { builtin: CREATIVE_SKILLS.map(brief), custom: custom.map(brief), activeSkillId: ctx.getCreativeMode() };
}

/** 当前激活的创作模式(dump):正文已注入系统提示,这里回简介供自查/续聊定位。 */
async function doCurrent(ctx: AgentContext): Promise<unknown> {
  const id = ctx.getCreativeMode();
  if (!id) return { active: null, note: '当前未选创作模式(系统提示无技能指引注入)。' };
  await refresh().catch(() => []); // 自定义技能需重读注册表;node 检查环境无 IDB 时静默跳过
  const s = findSkill(id);
  if (!s) return { active: { id }, note: '该技能定义已被删除,模式仍挂着旧 id;可 activate 换一个或传空串清除。' };
  return { active: { ...brief(s), builtin: isBuiltin(id) } };
}

/** 切换/清除创作模式(chat 级状态,即时生效、不进 undo;正文自下一条消息注入)。 */
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
  await refresh(); // 让 findSkill 能解析自定义 id
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
    nameZh: name, // 自定义技能中英同名(用户只给一个 name)
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
  // 不可变:返回新对象,只覆盖显式给出的字段
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

// 技能库是全局的(不按工程分);激活态(创作模式)是工程级 chat 状态,经 ctx 读写。
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
