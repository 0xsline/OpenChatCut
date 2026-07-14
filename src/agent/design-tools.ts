import Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from './context';
import {
  COLOR_ROLES, FONT_ROLES, type ColorRole, type DesignColor, type DesignFont,
  type DesignStyle, type FontRole,
} from '../editor/types';
import { DESIGN_STYLE_PRESETS, findPreset } from '../editor/design-presets';

// Source tool: manage_design_style — the design-style library IS the project's
// brand identity; it drives the colors + fonts the agent picks for MG/captions.
// Params mirror source: action / designSpec / applyToProject / presetId / patch.
export const DESIGN_TOOL_SCHEMAS: Anthropic.Tool[] = [{
  name: 'manage_design_style',
  description: [
    '管理工程的设计风格(品牌)。应用中的设计风格就是本工程的品牌,驱动你生成 MG/字幕时用的配色与字体。',
    'action: list | get | apply | update | clear.',
    'list=列出内置预设风格库; get=查看当前工程已应用的风格;',
    'apply=把某预设(presetId)或自定义 designSpec 套用到工程(applyToProject 默认 true);',
    'update=对当前风格做局部修改(patch,只补要改的字段); clear=清除风格。',
    'designSpec/patch 结构: {colors:[{role,value}], fonts:[{family,role}], styleGuide}。',
    `color role 取值: ${COLOR_ROLES.join('/')}; font role 取值: ${FONT_ROLES.join('/')}。`,
    'colors/fonts 也可传旧式对象形(如 {colors:{primary:"#..."}, fonts:{heading:"Inter"}}),会自动规整为数组。',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'apply', 'update', 'clear'] },
      presetId: { type: 'string', description: 'apply: 内置预设 id(先用 list 查看)。' },
      designSpec: { type: 'string', description: 'apply: 自定义风格的 JSON,含 colors/fonts/styleGuide。' },
      patch: { type: 'string', description: 'update: 局部修改的 JSON(只写要改的字段)。' },
      applyToProject: { type: 'boolean', description: 'apply: 是否立即套到当前工程(默认 true)。' },
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

// ── source normalizers (yM/xM/bM): accept array OR legacy role-keyed object ──
function normColors(raw: unknown): DesignColor[] {
  if (Array.isArray(raw)) {
    return raw
      .map((c) => (c && typeof c === 'object' ? { role: String((c as Args).role) as ColorRole, value: String((c as Args).value ?? '') } : null))
      .filter((c): c is DesignColor => !!c && COLOR_ROLES.includes(c.role) && c.value.trim() !== '');
  }
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  return COLOR_ROLES.flatMap((role) => (typeof obj[role] === 'string' && obj[role] ? [{ role, value: obj[role] as string }] : []));
}

function normFonts(raw: unknown): DesignFont[] {
  if (Array.isArray(raw)) {
    return raw
      .map((f) => (f && typeof f === 'object' ? { family: String((f as Args).family ?? ''), role: String((f as Args).role) as FontRole } : null))
      .filter((f): f is DesignFont => !!f && FONT_ROLES.includes(f.role) && f.family.trim() !== '');
  }
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  return FONT_ROLES.flatMap((role) => (typeof obj[role] === 'string' && obj[role] ? [{ family: obj[role] as string, role }] : []));
}

/** normalize an arbitrary designSpec into a DesignStyle (source bM). */
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
    case 'list':
      return DESIGN_STYLE_PRESETS.map((p) => ({ presetId: p.id, name: p.name, style: summarize(p.style) }));

    case 'get':
      return { designStyle: summarize(ctx.getDoc().designStyle) };

    case 'apply': {
      let style: DesignStyle | null = null;
      if (args.presetId) {
        const preset = findPreset(String(args.presetId));
        if (!preset) return { error: `no preset "${args.presetId}"`, available: DESIGN_STYLE_PRESETS.map((p) => p.id) };
        style = preset.style;
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

    default:
      return { error: `unknown action "${action}"; use list|get|apply|update|clear` };
  }
}
