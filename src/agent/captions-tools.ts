import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from './context';
import { trackAlias } from '../editor/types';
import type { CaptionWordOverride, CaptionsData } from '../captions/types';
import { paginate } from '../captions/types';
import { resolveCaptionWords, resolveCaptionWordIndices, applyWordOverrides } from '../captions/resolve';
import { CAPTION_STYLE_BY_ID } from '../captions/styles';

// 逐词字幕覆盖(word overrides):在不改动 transcript/timing 的前提下,让 agent
// 隐藏某个词、替换其显示文本、或在某词前强制换页。数据落在 CaptionsData.wordOverrides
// (src/captions/types.ts),分页/渲染逻辑见 src/captions/resolve.ts + CaptionsLayer.tsx。
// 这里只是读/写这份覆盖表的两个 agent 工具。
//
// set_caption_sources(自定工具名——逆向 `复刻规格-Agent工具与后端.md` 的 edit_captions
// 条目只写"源路由",未见 source_set/source_add/sourceScope 等真实动作名):把字幕源从
// 单个 sourceItemId 扩到"多轨转写合并成一条时间线"(CaptionsData.sources/sourceMode,
// src/captions/types.ts)。真正的合并/排序在 resolve.ts 的 resolveCaptionWords 里,这里
// 只做校验 + 落盘(ctx.commands.updateCaptions),不碰 reducer/store。

export const CAPTIONS_TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'read_captions',
    description: "Read the captions overlay's current state (enabled/template/pacing/source track) and its resolved pages — each word's index in the source transcript, its currently DISPLAYED text (after any override), and the active override on it (if any). Use before edit_caption_words to pick wordIndex values.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'edit_caption_words',
    description: "Apply per-word DISPLAY overrides to the captions overlay — hide a word, replace its shown text, or force a new caption page to start at it — WITHOUT touching the underlying transcript or timing. wordIndex is the word's index in the source track transcript (get it from read_captions). Pass clear:true to remove a word's override instead.",
    input_schema: {
      type: 'object',
      properties: {
        overrides: {
          type: 'array',
          description: 'One or more per-word overrides to merge into the captions.',
          items: {
            type: 'object',
            properties: {
              wordIndex: { type: 'number', description: "the word's index in the source transcript." },
              hidden: { type: 'boolean', description: 'hide this word from the captions overlay.' },
              text: { type: 'string', description: 'replace the displayed text for this word (transcript/timing unchanged).' },
              forceBreak: { type: 'boolean', description: 'start a new caption page right at this word.' },
              clear: { type: 'boolean', description: 'remove any existing override for this word (other fields ignored).' },
            },
            required: ['wordIndex'],
          },
        },
      },
      required: ['overrides'],
    },
  },
  {
    name: 'set_caption_sources',
    description: "Route the captions overlay to merge word-level transcripts from MULTIPLE items/tracks into one time-ordered caption stream (e.g. two speakers on two audio tracks -> one caption overlay), instead of a single sourceItemId. Pass `sources` (item ids, each must already have a transcript) to merge exactly those items, or `mode:'timeline'` to merge EVERY transcribed item on the timeline. Omitting both `sources` and `mode` leaves the existing single-source routing untouched.",
    input_schema: {
      type: 'object',
      properties: {
        sources: {
          type: 'array',
          items: { type: 'string' },
          description: 'item ids whose transcripts merge into the captions, sorted by absolute start time. Each id must reference an item that already has a transcript.',
        },
        mode: {
          type: 'string',
          enum: ['item', 'timeline'],
          description: "'timeline' merges every transcribed item on the timeline (ignores `sources`/sourceItemId); 'item' returns to single-source routing (sourceItemId, or `sources` if set).",
        },
      },
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
      const indices = resolveCaptionWordIndices(c, s.items);
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
    case 'edit_caption_words': {
      if (!c) return { error: 'captions are not set up yet; call edit_captions first' };
      const raw = args.overrides;
      if (!Array.isArray(raw) || raw.length === 0) return { error: 'overrides must be a non-empty array' };
      const item = c.sourceItemId ? s.items.find((it) => it.id === c.sourceItemId) : undefined;
      const total = item?.transcript?.length ?? c.words?.length ?? 0;
      const next: Record<number, CaptionWordOverride> = { ...(c.wordOverrides ?? {}) };
      const errors: string[] = [];
      for (const entry of raw) {
        if (!entry || typeof entry !== 'object') { errors.push('skipped a non-object entry'); continue; }
        const e = entry as Record<string, unknown>;
        const wordIndex = e.wordIndex;
        if (typeof wordIndex !== 'number' || !Number.isInteger(wordIndex) || wordIndex < 0) {
          errors.push(`invalid wordIndex: ${JSON.stringify(wordIndex)}`);
          continue;
        }
        if (total > 0 && wordIndex >= total) {
          errors.push(`wordIndex ${wordIndex} out of range (0..${total - 1})`);
          continue;
        }
        if (e.clear) { delete next[wordIndex]; continue; }
        const patch: CaptionWordOverride = {};
        if (typeof e.hidden === 'boolean') patch.hidden = e.hidden;
        if (typeof e.text === 'string') patch.text = e.text;
        if (typeof e.forceBreak === 'boolean') patch.forceBreak = e.forceBreak;
        if (Object.keys(patch).length === 0) { errors.push(`wordIndex ${wordIndex}: no fields to apply`); continue; }
        next[wordIndex] = { ...next[wordIndex], ...patch };
      }
      ctx.commands.updateCaptions({ wordOverrides: next });
      return { ok: true, overrides: Object.keys(next).length, ...(errors.length ? { errors } : {}) };
    }
    case 'set_caption_sources': {
      if (!c) return { error: 'captions are not set up yet; call edit_captions first' };
      const rawMode = args.mode;
      if (rawMode !== undefined && rawMode !== 'item' && rawMode !== 'timeline') {
        return { error: `invalid mode: ${JSON.stringify(rawMode)} (expected 'item' or 'timeline')` };
      }
      const rawSources = args.sources;
      let sources: string[] | undefined;
      if (rawSources !== undefined) {
        if (!Array.isArray(rawSources) || rawSources.some((id) => typeof id !== 'string')) {
          return { error: 'sources must be an array of item ids' };
        }
        const missing = rawSources.filter((id) => !s.items.some((it) => it.id === id && (it.transcript?.length ?? 0) > 0));
        if (missing.length) return { error: `unknown or untranscribed item id(s): ${missing.join(', ')}` };
        sources = rawSources;
      }
      const mode = rawMode as 'item' | 'timeline' | undefined;
      if (sources === undefined && mode === undefined) return { error: 'nothing to update: pass sources and/or mode' };
      const patch: Partial<CaptionsData> = {};
      if (sources !== undefined) patch.sources = sources;
      if (mode !== undefined) patch.sourceMode = mode;
      ctx.commands.updateCaptions(patch);
      const nextCaptions: CaptionsData = { ...c, ...patch };
      return {
        ok: true,
        sources: nextCaptions.sources ?? null,
        mode: nextCaptions.sourceMode ?? 'item',
        wordCount: resolveCaptionWords(nextCaptions, s.items, s.fps).length,
      };
    }
    default:
      return undefined;
  }
}
