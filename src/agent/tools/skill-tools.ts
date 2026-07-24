import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import { CREATIVE_SKILLS, findSkill, setCustomSkills, type CreativeSkill } from '../skills/skills-catalog';
import { listCustomSkills, saveCustomSkill, deleteCustomSkill, type CustomSkill } from '../../persist/skillStore';

// manage_skill — Custom creation skills (in-app agent unique tool,
// tied with track_progress). Skill = a creative mode guide (bodyMarkdown), which injects system prompts after selection.
// action: list (built-in + custom columns)/ get (view the text of a skill)/ create (new custom)/
// update (change to custom)/delete (delete custom).
// Boundary: LLM input is not trustworthy - name/body non-empty verification; only customization can be changed/delete, and built-in skills are read-only.
// After mutation setCustomSkills(await listCustomSkills()) synchronizes the memory registry and lets findSkill/drop
// See changes immediately within the session. Determination and undo are driven by UI selections, and the tool itself only maintains a library of skills.

type Args = Record<string, unknown>;

export const SKILL_TOOL_SCHEMAS: AgentToolSchema[] = [{
  name: 'manage_skill',
  description: [
    'Custom creation skills = A reusable creative mode guide(bodyMarkdown),Appears alongside built-in skills under "Creative Mode",Inject system prompts after selection,guidance AI planning and process(No changes to available tools)。',
    'action: list | get | current | activate | create | update | delete.',
    'list = List all skills(Built-in read-only + Customize,Each belt id/name/summary;attached activeSkillId)。',
    'get(bring skillId)= View details of a skill(Contains complete body Text;builtin Mark whether the skill is built-in)。',
    'current = View currently activated creative modes(No rules active:null)。',
    'activate(bring skillId;Pass empty string to clear)= Switch the creative mode of this project - the user selects the mode in the form card and uses it to apply it for the user;The guidance text is injected starting from the next message.',
    'create(bring name + body,Optional summary/scenarios)= Create a new custom skill and generate id;name/body Required and not empty.',
    'update(bring skillId + Field to be changed)= Modify a custom skill(Can only be customized,Built-in read-only)。',
    'delete(bring skillId)= Delete a custom skill(Can only delete customized,Built-in cannot be deleted)。',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'current', 'activate', 'create', 'update', 'delete'] },
      skillId: { type: 'string', description: 'get/update/delete/activate target skills id(use list Take first);activate Pass empty string = Clear creative mode.' },
      name: { type: 'string', description: 'create/update: Skill display name(create Required, not empty)。' },
      body: { type: 'string', description: 'create/update: Skill guide text(Markdown,Inject system prompts;create Required, not empty)。' },
      summary: { type: 'string', description: 'create/update: One sentence description(Optional;create Used by default name)。' },
      scenarios: { type: 'array', items: { type: 'string' }, description: 'create/update: Trigger scene keywords(Optional)。' },
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

/** from IDB Reread custom skills and synchronize memory registry,let findSkill/Instantly fresh within the drop down session. */
async function refresh(): Promise<CustomSkill[]> {
  const list = await listCustomSkills();
  setCustomSkills(list);
  return list;
}

async function doList(ctx: AgentContext): Promise<unknown> {
  const custom = await refresh();
  return { builtin: CREATIVE_SKILLS.map(brief), custom: custom.map(brief), activeSkillId: ctx.getCreativeMode() };
}

/** Currently active creative mode(dump):The text has been injected into the system prompt,Here is the introduction for self-examination/Let’s continue talking about positioning. */
async function doCurrent(ctx: AgentContext): Promise<unknown> {
  const id = ctx.getCreativeMode();
  if (!id) return { active: null, note: 'No creative mode is currently selected(System prompts that no skill guidance is injected)。' };
  await refresh().catch(() => []); // Custom skills need to re-read the registry; node checks the environment and skips silently if there is no IDB.
  const s = findSkill(id);
  if (!s) return { active: { id }, note: 'The skill definition has been deleted,mode still hangs old id;Yes activate Change it or pass an empty string to clear it.' };
  return { active: { ...brief(s), builtin: isBuiltin(id) } };
}

/** switch/Clear creative mode(chat level status,Effective immediately, no progress undo;The text is injected from the next message)。 */
async function doActivate(args: Args, ctx: AgentContext): Promise<unknown> {
  if (!ctx.setCreativeMode) return { error: 'this host cannot switch creative mode' };
  const id = strArg(args.skillId);
  if (!id) {
    ctx.setCreativeMode(null);
    return { ok: true, active: null, note: 'Creative mode cleared.' };
  }
  await refresh().catch(() => []);
  const s = findSkill(id);
  if (!s) return { error: `no skill "${id}"; use list to see available ids` };
  ctx.setCreativeMode(id);
  return { ok: true, active: { ...brief(s), builtin: isBuiltin(id) }, note: 'Switched;The guidance text for this mode is injected into the system prompt starting from the next message.' };
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
