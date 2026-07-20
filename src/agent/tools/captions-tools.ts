import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from '../context';
import { trackAlias } from '../../editor/types';
import type { CaptionWordOverride } from '../../captions/types';
import { paginate } from '../../captions/types';
import { resolveCaptionWords, resolveCaptionWordIndices, applyWordOverrides } from '../../captions/resolve';
import { CAPTION_STYLE_BY_ID } from '../../captions/styles';
import { editCaptions } from './captions-actions';

// Captions tools: `read_captions` (read-only) + `edit_captions`
// (ONE tool, 21-action dispatch — see captions-actions.ts). Word overrides
// (display_text), multi-source routing (source_*), and language (language_mode /
// bilingual) are all edit_captions actions now; the old flat edit_captions and the
// edit_caption_words / set_caption_sources behavior is folded in.

const CAPTION_ACTIONS = ['enable', 'disable', 'display_text', 'template', 'style', 'layout', 'layout_policy', 'positions', 'preset_apply', 'preset_delete', 'preset_list', 'preset_rename', 'preset_save', 'bilingual', 'language_mode', 'source_add', 'source_list', 'source_remove', 'source_set', 'source_update', 'track'];

export const CAPTIONS_TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'read_captions',
    description: "Read the captions overlay's current state (enabled/template/pacing/source track) and its resolved pages — each word's index in the source transcript, its currently DISPLAYED text (after any override), and the active override on it (if any). Use before edit_captions action=display_text to pick wordIndex values.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'edit_captions',
    description:
      "Manage the captions/subtitles overlay via a single `action`. Read text first only for display_text (use read_captions); every other action is one direct call.\n" +
      "- enable / disable: toggle captions (enable optionally takes a built-in `preset` name).\n" +
      "- template: no arg → list the 21 built-in presets; `templatePreset:\"netflix\"` → apply one (size/position preserved).\n" +
      "- style: custom look via `json` — {font, sizePx|fontSizeRatio, color, weight, strokeColor, strokeWidth, highlightColor, highlightBackground, shadow|shadowStrength, textTransform, displayMode, wordsPerPage, pacing}. Layered over the current template; unmapped fields are reported in `ignored`. sizePx is relative to CANVAS height — on 9:16 vertical (1080×1920) social captions want sizePx ≥ 86 (≈4.5% of height); leave size unset to keep the template default. pacing: 'phrase' (default, readable pages + karaoke highlight) — only use 'word' when the user explicitly wants single-word pop.\n" +
      "- layout: place the whole block via `json` {preset:\"bottom-center|top-center|center|…3×3\", offsetXRatio, offsetYRatio}.\n" +
      "- display_text: per-word DISPLAY overrides via `json` {overrides:[{wordIndex, text, hidden, forcePageBreak}], clearOverrides} — get wordIndex from read_captions; doesn't touch the transcript.\n" +
      "- source_set / source_add / source_remove / source_list: choose which transcribed track(s)/item(s) the captions read (json {mode:\"timeline\"} for all audible, or {sources:[{trackId|itemId}]}).\n" +
      "- language_mode / bilingual: switch caption language — json {mode:\"original|translation|bilingual\", languageCode} (create the translation first with manage_transcript translate).\n" +
      "- track: legacy single-source trackId (prefer source_set).\n" +
      "layout_policy, positions, and preset_* (user-saved presets) are not modeled in this build and return an `unsupported` note.",
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: CAPTION_ACTIONS, description: 'The caption operation to perform.' },
        json: { type: 'string', description: 'JSON payload for the action (style fields, layout, display_text overrides, source scope, language). A JSON string or object.' },
        templatePreset: { type: 'string', description: 'For action=template: built-in preset id/name to apply (omit to list).' },
        preset: { type: 'string', description: 'For action=enable: optional built-in preset name ("auto"/omit = Plain default). For action=template: legacy alias for templatePreset.' },
        trackId: { type: 'string', description: 'For action=track only: source track alias (V1/A1) or id. To choose visible caption text prefer source_set.' },
        list: { type: 'boolean', description: 'For action=track: list available source tracks instead of changing the source.' },
        captionsItemId: { type: 'string', description: 'Optional captions layer id — this build has a single overlay, so it is accepted but not required.' },
      },
      required: ['action'],
    },
  },
];

export const CAPTIONS_TOOL_NAMES = new Set(CAPTIONS_TOOL_SCHEMAS.map((t) => t.name));

type Args = Record<string, unknown>;

export async function execCaptionsTool(name: string, args: Args, ctx: AgentContext): Promise<unknown | undefined> {
  const s = ctx.getState();
  const c = s.captions;

  switch (name) {
    case 'read_captions': {
      if (!c || !c.enabled) return { enabled: false, note: 'captions are off; call edit_captions to turn them on first' };
      const words = resolveCaptionWords(c, s.items, s.fps);
      if (!words.length) return { enabled: true, template: c.template, pacing: c.pacing, note: 'source track has no transcript words' };
      const indices = resolveCaptionWordIndices(c, s.items, s.fps);
      const item = c.sourceItemId ? s.items.find((it) => it.id === c.sourceItemId) : undefined;
      // 不在这里丢隐藏词——只做文本替换/换页,让 agent 能在页面里看到已隐藏词的下标+现状,方便决定是否取消隐藏。
      let visibleOverrides: Record<number, CaptionWordOverride> | undefined;
      if (c.wordOverrides) {
        visibleOverrides = {};
        for (const [k, v] of Object.entries(c.wordOverrides)) visibleOverrides[Number(k)] = { ...v, hidden: false };
      }
      const { words: dispWords, breakBefore } = applyWordOverrides(words, indices, visibleOverrides);
      const wordsPerPage = CAPTION_STYLE_BY_ID[c.template].wordsPerPage;
      const pages = paginate(dispWords, c.pacing, wordsPerPage, breakBefore);
      let cursor = 0;
      const pagesOut = pages.map((p) => ({
        start: p.start,
        end: p.end,
        words: p.words.map((w) => {
          const idx = indices[cursor++];
          return { index: idx, text: w.text, override: c.wordOverrides?.[idx] ?? null };
        }),
      }));
      return {
        enabled: true,
        template: c.template,
        pacing: c.pacing,
        track: item ? trackAlias(s, item.track) : null,
        pageCount: pagesOut.length,
        pages: pagesOut,
      };
    }
    case 'edit_captions':
      return editCaptions(args, ctx);
    default:
      return undefined;
  }
}
