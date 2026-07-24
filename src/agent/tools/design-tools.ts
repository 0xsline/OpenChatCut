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
    'Management engineering design style(Brand). The design style in application is the brand of this project,drive you to generate MG/The colors and fonts used for subtitles.',
    'action: list | get | apply | update | clear | save | delete.',
    'list=List style libraries,Return {catalog(Built-in presets), owned(User"my style"Collection)}; get=View the styles applied to the current project;',
    'apply=put a certain style(presetId,Can be built-in or user favorites)or customize designSpec Apply to project(applyToProject Default true);',
    'update=Make partial modifications to the current project style;pass presetId You can modify the content, name, scene label or thumbnail of the collection style; clear=Clear project style;',
    'save=put designSpec(Or if not uploaded, the style applied to the current project will be used.)deposited to the user"my style"Collection,Need name,Can be attached scenarios/thumbnailUrl; delete=Remove from favorites(presetId as favorites id;Built-in presets cannot be deleted)。',
    'designSpec/patch structure: {colors:[{role,value}], fonts:[{family,role}], styleGuide}。',
    `role is free text(The value is as "accent copper"/"text secondary"/"Chinese heading"),Commonly used color role: ${COLOR_ROLES.join('/')}; font role: ${FONT_ROLES.join('/')},But not limited to these.`,
    'styleGuide Can write detailed animations/spring/stagger Specifications.',
    'colors/fonts You can also pass old-style object shapes(Such as {colors:{primary:"#..."}, fonts:{heading:"Inter"}}),It will be automatically transformed into an array.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'apply', 'update', 'clear', 'save', 'delete'] },
      presetId: { type: 'string', description: 'apply/delete: style id(Built-in presets or"my style"favorites,Use first list View)。' },
      designSpec: { type: 'string', description: 'apply/save: Custom style JSON,Contains colors/fonts/styleGuide。' },
      patch: { type: 'string', description: 'update: partially modified JSON(Only write the fields you want to change)。' },
      applyToProject: { type: 'boolean', description: 'apply: Whether to apply it to the current project immediately(Default true)。' },
      name: { type: 'string', description: 'save: collection name(Required;The same name will overwrite existing collections)。' },
      rename: { type: 'string', description: 'update + presetId: New collection name;Automatically add a numeric suffix when the name is the same.' },
      scenarios: { type: 'array', items: { type: 'string' }, description: 'save/update: Applicable scene tags;Empty arrays are cleared.' },
      scenario: { type: 'string', description: 'list: Only styles containing this scene tag are returned.' },
      thumbnailUrl: { type: 'string', description: 'save/update: style selector cover URL;Does not participate in generation.' },
      clearThumbnail: { type: 'boolean', description: 'update + presetId: clear cover,Styles will not be deleted.' },
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
