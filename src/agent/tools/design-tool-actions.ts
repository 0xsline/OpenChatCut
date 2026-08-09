import type { AgentContext } from '../context';
import {
  COLOR_ROLES,
  FONT_ROLES,
  type DesignColor,
  type DesignFont,
  type DesignStyle,
} from '../../editor/types';
import { DESIGN_STYLE_PRESETS, findPreset } from '../../editor/design-presets';
import {
  deleteOwnedStyle,
  loadOwnedStyles,
  saveOwnedStyle,
  updateOwnedStyle,
} from '../../persist/ownedStyleStore';

export type DesignToolArgs = Record<string, unknown>;
type DesignToolResult = Promise<unknown> | unknown;
type ParsedSpec = DesignToolArgs | { error: string };

function parseSpec(value: unknown): ParsedSpec {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as DesignToolArgs;
  if (typeof value !== 'string') return { error: 'designSpec must be a JSON object string' };
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as DesignToolArgs
      : { error: 'designSpec must decode to an object' };
  } catch (error) {
    return { error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}
function isSpecError(spec: ParsedSpec): spec is { error: string } {
  return typeof spec.error === 'string';
}

function normalizeColors(raw: unknown): DesignColor[] {
  if (Array.isArray(raw)) {
    return raw
      .map((color) => color && typeof color === 'object' ? {
        role: String((color as DesignToolArgs).role ?? '').trim(),
        value: String((color as DesignToolArgs).value ?? '').trim(),
      } : null)
      .filter((color): color is DesignColor => !!color && color.role !== '' && color.value !== '');
  }
  if (!raw || typeof raw !== 'object') return [];
  const colors = raw as Record<string, unknown>;
  return COLOR_ROLES.flatMap((role) => typeof colors[role] === 'string' && colors[role]
    ? [{ role, value: colors[role] as string }]
    : []);
}

function normalizeFonts(raw: unknown): DesignFont[] {
  if (Array.isArray(raw)) {
    return raw
      .map((font) => font && typeof font === 'object' ? {
        family: String((font as DesignToolArgs).family ?? '').trim(),
        role: String((font as DesignToolArgs).role ?? '').trim(),
      } : null)
      .filter((font): font is DesignFont => !!font && font.role !== '' && font.family !== '');
  }
  if (!raw || typeof raw !== 'object') return [];
  const fonts = raw as Record<string, unknown>;
  return FONT_ROLES.flatMap((role) => typeof fonts[role] === 'string' && fonts[role]
    ? [{ family: fonts[role] as string, role }]
    : []);
}

function normalizeStyle(spec: DesignToolArgs): DesignStyle {
  const style: DesignStyle = { colors: normalizeColors(spec.colors), fonts: normalizeFonts(spec.fonts) };
  if (typeof spec.styleGuide === 'string' && spec.styleGuide.trim()) {
    style.styleGuide = spec.styleGuide.trim();
  }
  return style;
}

function styleSummary(style: DesignStyle | undefined) {
  return style
    ? { colors: style.colors, fonts: style.fonts, styleGuide: style.styleGuide ?? null }
    : null;
}

function normalizeScenarios(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(String).map((item) => item.trim()).filter(Boolean);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function matchesScenario(scenarios: string[] | undefined, requested: string): boolean {
  return !requested || !!scenarios?.some((scenario) => scenario.localeCompare(
    requested, undefined, { sensitivity: 'accent' },
  ) === 0);
}

async function listStyles(args: DesignToolArgs): Promise<unknown> {
  const owned = await loadOwnedStyles();
  const scenario = String(args.scenario ?? '').trim();
  return {
    catalog: DESIGN_STYLE_PRESETS
      .filter((preset) => matchesScenario(preset.scenarios, scenario))
      .map((preset) => ({
        presetId: preset.id,
        name: preset.name,
        thumbnailUrl: preset.thumbnailUrl ?? null,
        scenarios: preset.scenarios ?? [],
        style: styleSummary(preset.style),
      })),
    owned: owned
      .filter((style) => matchesScenario(style.scenarios, scenario))
      .map((style) => ({
        presetId: style.id,
        name: style.name,
        thumbnailUrl: style.thumbnailUrl ?? null,
        scenarios: style.scenarios ?? [],
        style: styleSummary(style.style),
      })),
  };
}

async function getStyle(args: DesignToolArgs, ctx: AgentContext): Promise<unknown> {
  const id = String(args.presetId ?? '').trim();
  if (!id) return { designStyle: styleSummary(ctx.getDoc().designStyle) };
  const preset = findPreset(id);
  if (preset) return {
    presetId: preset.id,
    name: preset.name,
    thumbnailUrl: preset.thumbnailUrl ?? null,
    scenarios: preset.scenarios ?? [],
    designStyle: styleSummary(preset.style),
  };
  const owned = (await loadOwnedStyles()).find((style) => style.id === id);
  if (!owned) return { error: `no style "${id}"` };
  return {
    presetId: owned.id,
    name: owned.name,
    thumbnailUrl: owned.thumbnailUrl ?? null,
    scenarios: owned.scenarios ?? [],
    designStyle: styleSummary(owned.style),
  };
}

async function resolveStyle(args: DesignToolArgs): Promise<DesignStyle | { error: string; available?: string[] }> {
  if (!args.presetId) {
    const spec = parseSpec(args.designSpec);
    return isSpecError(spec) ? spec : normalizeStyle(spec);
  }
  const id = String(args.presetId);
  const preset = findPreset(id);
  if (preset) return preset.style;
  const owned = (await loadOwnedStyles()).find((style) => style.id === id);
  return owned?.style ?? {
    error: `no style "${id}"`,
    available: DESIGN_STYLE_PRESETS.map((candidate) => candidate.id),
  };
}

async function applyStyle(args: DesignToolArgs, ctx: AgentContext): Promise<unknown> {
  const style = await resolveStyle(args);
  if ('error' in style) return style;
  if (style.colors.length === 0 && style.fonts.length === 0 && !style.styleGuide) {
    return { error: 'empty designSpec: need at least one color, font, or styleGuide (or a presetId)' };
  }
  if (args.applyToProject === false) {
    return { ok: true, applied: false, style: styleSummary(style) };
  }
  ctx.commands.setDesignStyle(style);
  return { ok: true, applied: true, style: styleSummary(style) };
}

function updatedOwnedStyle(current: DesignStyle, spec: DesignToolArgs): DesignStyle {
  return {
    colors: 'colors' in spec ? normalizeColors(spec.colors) : current.colors,
    fonts: 'fonts' in spec ? normalizeFonts(spec.fonts) : current.fonts,
    ...(typeof spec.styleGuide === 'string'
      ? spec.styleGuide.trim() ? { styleGuide: spec.styleGuide.trim() } : {}
      : current.styleGuide ? { styleGuide: current.styleGuide } : {}),
  };
}

async function updateOwned(args: DesignToolArgs, id: string): Promise<unknown> {
  if (findPreset(id)) return { error: "catalog styles can't be updated" };
  const owned = (await loadOwnedStyles()).find((style) => style.id === id);
  if (!owned) return { error: `no owned style "${id}"` };
  const spec = parseSpec(args.patch ?? args.designSpec);
  if (isSpecError(spec)) return spec;
  const style = updatedOwnedStyle(owned.style, spec);
  const updated = await updateOwnedStyle(id, {
    ...(typeof args.rename === 'string' ? { name: args.rename } : {}),
    ...(args.patch !== undefined || args.designSpec !== undefined ? { style } : {}),
    ...(hasOwn(args, 'scenarios') ? { scenarios: normalizeScenarios(args.scenarios) ?? [] } : {}),
    ...(args.clearThumbnail === true
      ? { thumbnailUrl: null }
      : hasOwn(args, 'thumbnailUrl') ? { thumbnailUrl: String(args.thumbnailUrl ?? '') } : {}),
  });
  return { ok: true, updated };
}

function updateProject(args: DesignToolArgs, ctx: AgentContext): unknown {
  const current = ctx.getDoc().designStyle;
  if (!current) return { error: 'no design style applied yet; use action="apply" first' };
  const spec = parseSpec(args.patch ?? args.designSpec);
  if (isSpecError(spec)) return spec;
  const patch: Partial<DesignStyle> = {};
  if ('colors' in spec) patch.colors = normalizeColors(spec.colors);
  if ('fonts' in spec) patch.fonts = normalizeFonts(spec.fonts);
  if (typeof spec.styleGuide === 'string') patch.styleGuide = spec.styleGuide.trim();
  ctx.commands.patchDesignStyle(patch);
  return { ok: true, style: styleSummary(ctx.getDoc().designStyle) };
}

async function updateStyle(args: DesignToolArgs, ctx: AgentContext): Promise<unknown> {
  const id = String(args.presetId ?? '').trim();
  return id ? updateOwned(args, id) : updateProject(args, ctx);
}

function styleForSave(args: DesignToolArgs, ctx: AgentContext): DesignStyle | { error: string } {
  if (!args.designSpec) {
    return ctx.getDoc().designStyle
      ?? { error: 'no designSpec given and no style applied to the project yet' };
  }
  const spec = parseSpec(args.designSpec);
  if (isSpecError(spec)) return spec;
  const style = normalizeStyle(spec);
  if (style.colors.length === 0 && style.fonts.length === 0 && !style.styleGuide) {
    return { error: 'empty designSpec: need at least one color, font, or styleGuide' };
  }
  return style;
}

async function saveStyle(args: DesignToolArgs, ctx: AgentContext): Promise<unknown> {
  const styleName = String(args.name ?? '').trim();
  if (!styleName) return { error: 'save requires a non-empty "name"' };
  const style = styleForSave(args, ctx);
  if ('error' in style) return style;
  const saved = await saveOwnedStyle(styleName, style, {
    ...(hasOwn(args, 'scenarios') ? { scenarios: normalizeScenarios(args.scenarios) ?? [] } : {}),
    ...(hasOwn(args, 'thumbnailUrl') ? { thumbnailUrl: String(args.thumbnailUrl ?? '') } : {}),
  });
  return { ok: true, saved };
}

async function deleteStyle(args: DesignToolArgs): Promise<unknown> {
  const id = String(args.presetId ?? '').trim();
  if (!id) return { error: 'delete requires "presetId" (the owned style id)' };
  if (findPreset(id)) return { error: "catalog styles can't be deleted" };
  const owned = await loadOwnedStyles();
  if (!owned.some((style) => style.id === id)) return { error: `no owned style "${id}"` };
  await deleteOwnedStyle(id);
  return { ok: true, deleted: id };
}

export function executeDesignAction(
  action: string,
  args: DesignToolArgs,
  ctx: AgentContext,
): DesignToolResult {
  switch (action) {
    case 'list': return listStyles(args);
    case 'get': return getStyle(args, ctx);
    case 'apply': return applyStyle(args, ctx);
    case 'update': return updateStyle(args, ctx);
    case 'clear':
      ctx.commands.setDesignStyle(null);
      return { ok: true, cleared: true };
    case 'save': return saveStyle(args, ctx);
    case 'delete': return deleteStyle(args);
    default:
      return { error: `unknown action "${action}"; use list|get|apply|update|clear|save|delete` };
  }
}
