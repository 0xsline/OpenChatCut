import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import {
  COLOR_ROLES, FONT_ROLES, type DesignColor, type DesignFont, type DesignStyle,
} from '../../editor/types';
import { DESIGN_STYLE_PRESETS, findPreset } from '../../editor/design-presets';
import { loadOwnedStyles, saveOwnedStyle, deleteOwnedStyle } from '../../persist/projectStore';

// manage_design_style controls the project's reusable brand identity and drives
// the colors and fonts the agent selects for motion graphics and captions.
// Styles come from the public catalog or the user's global personal library.
export const DESIGN_TOOL_SCHEMAS: AgentToolSchema[] = [{
  name: 'manage_design_style',
  description: [
    '管理工程的设计风格(品牌)。应用中的设计风格就是本工程的品牌,驱动你生成 MG/字幕时用的配色与字体。',
    'action: list | get | apply | update | clear | save | delete.',
    'list=列出风格库,返回 {catalog(内置预设), owned(用户"我的风格"收藏)}; get=查看当前工程已应用的风格;',
    'apply=把某风格(presetId,内置或用户收藏均可)或自定义 designSpec 套用到工程(applyToProject 默认 true);',
    'update=对当前风格做局部修改(patch,只补要改的字段); clear=清除风格;',
    'save=把 designSpec(或未传时用当前工程已应用的风格)存入用户的"我的风格"收藏,需 name; delete=从"我的风格"收藏中删除(presetId 为收藏项 id;内置预设不可删除)。',
    'designSpec/patch 结构: {colors:[{role,value}], fonts:[{family,role}], styleGuide}。',
    `role 是自由文本(取值如 "accent copper"/"text secondary"/"Chinese heading"),常用 color role: ${COLOR_ROLES.join('/')}; font role: ${FONT_ROLES.join('/')},但不限于这些。`,
    'styleGuide 可写详细的动效/spring/stagger 规格。',
    'colors/fonts 也可传旧式对象形(如 {colors:{primary:"#..."}, fonts:{heading:"Inter"}}),会自动规整为数组。',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'apply', 'update', 'clear', 'save', 'delete'] },
      presetId: { type: 'string', description: 'apply/delete: 风格 id(内置预设或"我的风格"收藏项,先用 list 查看)。' },
      designSpec: { type: 'string', description: 'apply/save: 自定义风格的 JSON,含 colors/fonts/styleGuide。' },
      patch: { type: 'string', description: 'update: 局部修改的 JSON(只写要改的字段)。' },
      applyToProject: { type: 'boolean', description: 'apply: 是否立即套到当前工程(默认 true)。' },
      name: { type: 'string', description: 'save: 收藏名称(必填;同名会覆盖已有收藏)。' },
    },
    required: ['action'],
  },
}];

export const DESIGN_TOOL_NAMES = new Set(DESIGN_TOOL_SCHEMAS.map((t) => t.name));

type Args = Record<string, unknown>;

/** parse a designSpec/patch arg that may be a JSON string or already an object. */
function parseSpec(value: unknown): Args | { error: string } {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Args;
  if (typeof value !== 'string') return { error: 'designSpec must be a JSON object string' };
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Args) : { error: 'designSpec must decode to an object' };
  } catch (e) {
    return { error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ── Design-spec normalizers: accept arrays or legacy role-keyed objects ──
// Roles are FREE-FORM (live catalog uses "accent copper", "text secondary",
// "Chinese heading", …) — the array form keeps ANY non-empty role. Only the
// legacy object form iterates the canonical role lists (that's what it keyed on).
function normColors(raw: unknown): DesignColor[] {
  if (Array.isArray(raw)) {
    return raw
      .map((c) => (c && typeof c === 'object' ? { role: String((c as Args).role ?? '').trim(), value: String((c as Args).value ?? '').trim() } : null))
      .filter((c): c is DesignColor => !!c && c.role !== '' && c.value !== '');
  }
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  return COLOR_ROLES.flatMap((role) => (typeof obj[role] === 'string' && obj[role] ? [{ role, value: obj[role] as string }] : []));
}

function normFonts(raw: unknown): DesignFont[] {
  if (Array.isArray(raw)) {
    return raw
      .map((f) => (f && typeof f === 'object' ? { family: String((f as Args).family ?? '').trim(), role: String((f as Args).role ?? '').trim() } : null))
      .filter((f): f is DesignFont => !!f && f.role !== '' && f.family !== '');
  }
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  return FONT_ROLES.flatMap((role) => (typeof obj[role] === 'string' && obj[role] ? [{ family: obj[role] as string, role }] : []));
}

/** Normalize an arbitrary designSpec into a DesignStyle. */
function normStyle(spec: Args): DesignStyle {
  const style: DesignStyle = { colors: normColors(spec.colors), fonts: normFonts(spec.fonts) };
  if (typeof spec.styleGuide === 'string' && spec.styleGuide.trim()) style.styleGuide = spec.styleGuide.trim();
  return style;
}

const summarize = (s: DesignStyle | undefined) =>
  s ? { colors: s.colors, fonts: s.fonts, styleGuide: s.styleGuide ?? null } : null;

export async function execDesignTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'manage_design_style') return { error: `unknown tool ${name}` };
  const action = String(args.action ?? '');

  switch (action) {
    case 'list': {
      const owned = await loadOwnedStyles();
      return {
        catalog: DESIGN_STYLE_PRESETS.map((p) => ({ presetId: p.id, name: p.name, style: summarize(p.style) })),
        owned: owned.map((s) => ({ presetId: s.id, name: s.name, style: summarize(s.style) })),
      };
    }

    case 'get':
      return { designStyle: summarize(ctx.getDoc().designStyle) };

    case 'apply': {
      let style: DesignStyle | null = null;
      if (args.presetId) {
        const id = String(args.presetId);
        const preset = findPreset(id);
        if (preset) {
          style = preset.style;
        } else {
          const ownedMatch = (await loadOwnedStyles()).find((s) => s.id === id);
          if (!ownedMatch) return { error: `no style "${id}"`, available: DESIGN_STYLE_PRESETS.map((p) => p.id) };
          style = ownedMatch.style;
        }
      } else {
        const spec = parseSpec(args.designSpec);
        if ('error' in spec) return spec;
        style = normStyle(spec);
      }
      if (style.colors.length === 0 && style.fonts.length === 0 && !style.styleGuide) {
        return { error: 'empty designSpec: need at least one color, font, or styleGuide (or a presetId)' };
      }
      if (args.applyToProject === false) return { ok: true, applied: false, style: summarize(style) };
      ctx.commands.setDesignStyle(style);
      return { ok: true, applied: true, style: summarize(style) };
    }

    case 'update': {
      const current = ctx.getDoc().designStyle;
      if (!current) return { error: 'no design style applied yet; use action="apply" first' };
      const spec = parseSpec(args.patch ?? args.designSpec);
      if ('error' in spec) return spec;
      const patch: Partial<DesignStyle> = {};
      if ('colors' in spec) patch.colors = normColors(spec.colors);
      if ('fonts' in spec) patch.fonts = normFonts(spec.fonts);
      if (typeof spec.styleGuide === 'string') patch.styleGuide = spec.styleGuide.trim();
      ctx.commands.patchDesignStyle(patch);
      return { ok: true, style: summarize(ctx.getDoc().designStyle) };
    }

    case 'clear':
      ctx.commands.setDesignStyle(null);
      return { ok: true, cleared: true };

    // "我的风格" is a global personal library, not a project-scoped collection.
    // Writes go straight to the store, bypassing
    // ctx.commands (there is no timeline edit / undo entry to make).
    case 'save': {
      const styleName = String(args.name ?? '').trim();
      if (!styleName) return { error: 'save requires a non-empty "name"' };
      let style: DesignStyle;
      if (args.designSpec) {
        const spec = parseSpec(args.designSpec);
        if ('error' in spec) return spec;
        style = normStyle(spec);
        if (style.colors.length === 0 && style.fonts.length === 0 && !style.styleGuide) {
          return { error: 'empty designSpec: need at least one color, font, or styleGuide' };
        }
      } else {
        const current = ctx.getDoc().designStyle;
        if (!current) return { error: 'no designSpec given and no style applied to the project yet' };
        style = current;
      }
      const saved = await saveOwnedStyle(styleName, style);
      return { ok: true, saved };
    }

    case 'delete': {
      const id = String(args.presetId ?? '').trim();
      if (!id) return { error: 'delete requires "presetId" (the owned style id)' };
      if (findPreset(id)) return { error: "catalog styles can't be deleted" };
      const owned = await loadOwnedStyles();
      if (!owned.some((s) => s.id === id)) return { error: `no owned style "${id}"` };
      await deleteOwnedStyle(id);
      return { ok: true, deleted: id };
    }

    default:
      return { error: `unknown action "${action}"; use list|get|apply|update|clear|save|delete` };
  }
}
