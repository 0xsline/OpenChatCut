import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from './context';
import { CREATIVE_SKILLS, findSkill, setCustomSkills, type CreativeSkill } from './skills-catalog';
import { listCustomSkills, saveCustomSkill, deleteCustomSkill, type CustomSkill } from '../persist/skillStore';

// manage_skill — 自定义创作技能(source 复刻规格 §1:网页版 in-app agent 独有工具,
// 与 track_progress 并列)。技能 = 一段创作模式指引(bodyMarkdown),选中后注入系统提示。
// action: list(内置+自定义都列)/ get(查看某技能正文)/ create(新建自定义)/
// update(改自定义)/ delete(删自定义)。
// 边界:LLM 输入不可信——name/body 非空校验;只能改/删自定义,内置技能只读。
// mutation 后 setCustomSkills(await listCustomSkills()) 同步内存注册表,让 findSkill/下拉
// 会话内立即看到变化(护城河:确定性、可撤销由 UI 选中驱动,工具本身只维护技能库)。

type Args = Record<string, unknown>;

export const SKILL_TOOL_SCHEMAS: Anthropic.Tool[] = [{
  name: 'manage_skill',
  description: [
    '自定义创作技能 = 一段可复用的创作模式指引(bodyMarkdown),与内置技能并列出现在「创作模式」下拉里,选中后注入系统提示,指导 AI 的规划与流程(不改变可用工具)。',
    'action: list | get | create | update | delete.',
    'list = 列出全部技能(内置只读 + 自定义,各带 id/name/summary)。',
    'get(带 skillId)= 查看某技能详情(含完整 body 正文;builtin 标记该技能是否内置)。',
    'create(带 name + body,可选 summary/scenarios)= 新建一个自定义技能并生成 id;name/body 必填非空。',
    'update(带 skillId + 要改的字段)= 修改一个自定义技能(只能改自定义,内置只读)。',
    'delete(带 skillId)= 删除一个自定义技能(只能删自定义,内置不可删)。',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete'] },
      skillId: { type: 'string', description: 'get/update/delete 的目标技能 id;用 list 先取。' },
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

async function doList(): Promise<unknown> {
  const custom = await refresh();
  return { builtin: CREATIVE_SKILLS.map(brief), custom: custom.map(brief) };
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

// ponytail: 技能库是全局的(不按工程分),execSkillTool 不需要 ctx;保留标准三件套签名。
export async function execSkillTool(name: string, args: Args, _ctx: AgentContext): Promise<unknown> {
  if (name !== 'manage_skill') return { error: `unknown tool ${name}` };
  switch (String(args.action ?? '')) {
    case 'list': return doList();
    case 'get': return doGet(args);
    case 'create': return doCreate(args);
    case 'update': return doUpdate(args);
    case 'delete': return doDelete(args);
    default: return { error: `unknown action "${args.action}"; use list|get|create|update|delete` };
  }
}
