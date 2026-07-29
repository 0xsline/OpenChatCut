import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import {
  COLOR_ROLES, FONT_ROLES, type DesignColor, type DesignFont, type DesignStyle,
} from '../../editor/types';
import { DESIGN_STYLE_PRESETS, findPreset } from '../../editor/design-presets';
import {
  loadOwnedStyles, saveOwnedStyle, updateOwnedStyle, deleteOwnedStyle,
} from '../../persist/projectStore';

// manage_design_style controls the project's reusable brand identity and drives
// the colors and fonts the agent selects for motion graphics and captions.
// Styles come from the public catalog or the user's global personal library.
export const DESIGN_TOOL_SCHEMAS: AgentToolSchema[] = [{
  name: 'manage_design_style',
  description: [
    'Manage the project design style (brand). The applied style is the project brand and drives the colors and fonts used for motion graphics and captions.',
    'action: list | get | apply | update | clear | save | delete.',
    'list returns {catalog (built-in presets), owned (user-saved styles)}; get returns the style applied to the current project;',
    'apply applies a presetId (built-in or user-saved) or custom designSpec to the project; applyToProject defaults to true;',
    'update partially changes the current project style; with presetId it can edit a saved style, name, scenario tags, or thumbnail; clear removes the project style;',
    'save stores designSpec, or the current project style when omitted, in the user library; name is required and scenarios/thumbnailUrl are optional; delete removes a saved style by presetId; built-in presets cannot be deleted.',
    'designSpec/patch shape: {colors:[{role,value}], fonts:[{family,role}], styleGuide}.',
    `role is free-form, for example "accent copper", "text secondary", or "Chinese heading". Common color roles: ${COLOR_ROLES.join('/')}; font roles: ${FONT_ROLES.join('/')}; other roles are allowed.`,
    'styleGuide may contain detailed motion, spring, and stagger specifications.',
    'colors/fonts also accept the legacy object form, for example {colors:{primary:"#..."}, fonts:{heading:"Inter"}}; it is normalized to arrays.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'apply', 'update', 'clear', 'save', 'delete'] },
      presetId: { type: 'string', description: 'apply/delete: style id from a built-in or user-saved style; call list first.' },
      designSpec: { type: 'string', description: 'apply/save: custom style JSON containing colors/fonts/styleGuide.' },
      patch: { type: 'string', description: 'update: partial JSON containing only fields to change.' },
      applyToProject: { type: 'boolean', description: 'apply: apply to the current project immediately; default true.' },
      name: { type: 'string', description: 'save: required saved-style name; replaces an existing style with the same name.' },
      rename: { type: 'string', description: 'update + presetId: new saved-style name; duplicate names get a numeric suffix.' },
      scenarios: { type: 'array', items: { type: 'string' }, description: 'save/update: scenario tags; an empty array clears them.' },
      scenario: { type: 'string', description: 'list: return only styles containing this scenario tag.' },
      thumbnailUrl: { type: 'string', description: 'save/update: cover URL for the style picker; not used for generation.' },
      clearThumbnail: { type: 'boolean', description: 'update + presetId: clear the cover without deleting the style.' },
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

const normalizeScenarioArgs = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  return value.map(String).map((item) => item.trim()).filter(Boolean);
};

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

const matchesScenario = (scenarios: string[] | undefined, requested: string): boolean =>
  !requested || !!scenarios?.some((scenario) => scenario.localeCompare(requested, undefined, { sensitivity: 'accent' }) === 0);

export async function execDesignTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'manage_design_style') return { error: `unknown tool ${name}` };
  const action = String(args.action ?? '');

  switch (action) {
    case 'list': {
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
            style: summarize(preset.style),
          })),
        owned: owned
          .filter((style) => matchesScenario(style.scenarios, scenario))
          .map((style) => ({
            presetId: style.id,
            name: style.name,
            thumbnailUrl: style.thumbnailUrl ?? null,
            scenarios: style.scenarios ?? [],
            style: summarize(style.style),
          })),
      };
    }

    case 'get': {
      const id = String(args.presetId ?? '').trim();
      if (!id) return { designStyle: summarize(ctx.getDoc().designStyle) };
      const preset = findPreset(id);
      if (preset) return {
        presetId: preset.id,
        name: preset.name,
        thumbnailUrl: preset.thumbnailUrl ?? null,
        scenarios: preset.scenarios ?? [],
        designStyle: summarize(preset.style),
      };
      const owned = (await loadOwnedStyles()).find((style) => style.id === id);
      if (!owned) return { error: `no style "${id}"` };
      return {
        presetId: owned.id,
        name: owned.name,
        thumbnailUrl: owned.thumbnailUrl ?? null,
        scenarios: owned.scenarios ?? [],
        designStyle: summarize(owned.style),
      };
    }

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
      const id = String(args.presetId ?? '').trim();
      if (id) {
        if (findPreset(id)) return { error: "catalog styles can't be updated" };
        const owned = (await loadOwnedStyles()).find((style) => style.id === id);
        if (!owned) return { error: `no owned style "${id}"` };
        const spec = parseSpec(args.patch ?? args.designSpec);
        if ('error' in spec) return spec;
        const nextStyle: DesignStyle = {
          colors: 'colors' in spec ? normColors(spec.colors) : owned.style.colors,
          fonts: 'fonts' in spec ? normFonts(spec.fonts) : owned.style.fonts,
          ...(typeof spec.styleGuide === 'string'
            ? (spec.styleGuide.trim() ? { styleGuide: spec.styleGuide.trim() } : {})
            : (owned.style.styleGuide ? { styleGuide: owned.style.styleGuide } : {})),
        };
        const updated = await updateOwnedStyle(id, {
          ...(typeof args.rename === 'string' ? { name: args.rename } : {}),
          ...(args.patch !== undefined || args.designSpec !== undefined ? { style: nextStyle } : {}),
          ...(hasOwn(args, 'scenarios') ? { scenarios: normalizeScenarioArgs(args.scenarios) ?? [] } : {}),
          ...(args.clearThumbnail === true
            ? { thumbnailUrl: null }
            : (hasOwn(args, 'thumbnailUrl') ? { thumbnailUrl: String(args.thumbnailUrl ?? '') } : {})),
        });
        return { ok: true, updated };
      }
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

    // "My Style" is a global personal library, not a project-scoped collection.
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
      const saved = await saveOwnedStyle(styleName, style, {
        ...(hasOwn(args, 'scenarios') ? { scenarios: normalizeScenarioArgs(args.scenarios) ?? [] } : {}),
        ...(hasOwn(args, 'thumbnailUrl') ? { thumbnailUrl: String(args.thumbnailUrl ?? '') } : {}),
      });
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
