import Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from './context';
import { defaultTrackId, resolveTrackId, trackAlias, type TimelineItem, type TrackId } from '../editor/types';
import type { TranscriptWord } from '../transcript/types';
import { msToFrame } from '../transcript/types';
import { transcribePath } from '../transcript/assemblyai';
import { fillerIndices } from '../transcript/edit';
import type { CaptionTemplate, CaptionPacing, CaptionsData } from '../captions/types';
import { buildTranslation, translateLines } from '../captions/translate';
import { createVariant, findVariantByLang, upsertVariant } from '../transcript/variants';

// Agent tools for the transcript / caption / "delete text = delete video" surface.
// Names + semantics mirror ChatCut's real tools (see chatcut-reverse
// 复刻规格-Agent工具与后端.md): transcribe (import_media/manage_transcript),
// find_transcript, clean_script, delete_text (apply_script), edit_captions.

export const TRANSCRIPT_TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'transcribe_track',
    description: 'Transcribe the audio clip on a track (word-level + speaker labels, via AssemblyAI) and attach the transcript. Required before find_transcript / clean_script / delete_text / captions when the clip has no transcript yet.',
    input_schema: { type: 'object', properties: { track: { type: 'string', description: 'Track alias or stable id whose audio to transcribe (default A1).' } } },
  },
  {
    name: 'find_transcript',
    description: 'Find where a phrase is spoken in a track\'s transcript. Returns the matching words and their timeline frame range (fromFrame/toFrame). Use to locate a spot before inserting B-roll/MG or before delete_text.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, track: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'clean_script',
    description: 'Mechanically clean a track\'s voiceover: compress long pauses to a target length and/or strip filler words (um/uh/嗯/呃). Rule-based on word timings (not the LLM); the clip shortens accordingly. Run before semantic editing.',
    input_schema: {
      type: 'object',
      properties: {
        track: { type: 'string' },
        maxPauseSeconds: { type: 'number', description: 'Compress pauses longer than this down to it (e.g. 0.5). Omit to leave pauses.' },
        removeFillers: { type: 'boolean', description: 'Strip filler words (default true).' },
      },
    },
  },
  {
    name: 'delete_text',
    description: 'Delete a spoken phrase from a track — "delete text = delete video": the matching words\' audio and their time are cut and the clip re-times. If unsure of the exact wording, find_transcript first.',
    input_schema: { type: 'object', properties: { track: { type: 'string' }, query: { type: 'string', description: 'The phrase to delete (matched against the transcript).' } }, required: ['query'] },
  },
  {
    name: 'manage_transcript',
    description: '管理转写文本与其多语言变体,不改动时间轴。action=fix("改错字"):把某个被听错的词替换成正确文本,定位要修的词二选一——传 wordIndex(词下标)或 find(错词原文,精确匹配一个词);只改 word.text。action=renameSpeaker(说话人重命名/合并):把 diarization 标签 from 的所有词改标为 to——同机制既可重命名("A"→"主持人")也可合并("B"→"A",两位说话人塌成一位);只改 word.speaker。action=translate(翻译变体):把该轨转写整段翻译成 lang 语言,生成一个"文本变体"(词级、共享同一时间轴)挂到该 clip;同 lang 已存在则复用(force=true 强制重译)。变体只承载译文,词的起止时间/帧位取自源词——用 edit_captions 的 variantLang 选它作为字幕显示语言。三种 action 都保持词的起止时间/帧位、词数、片段时长不变(captions/删文本都依赖这条不变式)。',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['fix', 'renameSpeaker', 'translate'], description: 'fix=改错字;renameSpeaker=说话人重命名/合并;translate=生成/复用翻译变体。' },
        itemId: { type: 'string', description: '目标转写所在 clip 的 item id;省略则取该 track 上第一个带转写的音/视频 clip。' },
        track: { type: 'string', description: 'itemId 省略时,用 track 别名/稳定 id 定位带转写的 clip(默认 A1)。' },
        wordIndex: { type: 'number', description: 'fix:要修正的词下标(与 find 二选一)。' },
        find: { type: 'string', description: 'fix:要修正的错词原文,精确匹配一个词(与 wordIndex 二选一)。' },
        text: { type: 'string', description: 'fix:修正后的正确文本。' },
        from: { type: 'string', description: 'renameSpeaker:要重命名的现有说话人标签(如 "A"/"B")。' },
        to: { type: 'string', description: 'renameSpeaker:新的说话人显示名;传一个已存在的标签即合并两位说话人(如 "B"→"A")。' },
        lang: { type: 'string', description: 'translate:目标语言(如 "English"/"中文"/"日本語"),必填非空。' },
        force: { type: 'boolean', description: 'translate:同 lang 变体已存在时是否强制重新翻译并覆盖(默认 false=复用已有)。' },
      },
      required: ['action'],
    },
  },
  {
    name: 'edit_captions',
    description: 'Turn the captions overlay on/off and set its style. Captions are a single overlay that mirrors a track\'s transcript and follow edits automatically. Templates: plain, tiktok (big karaoke), netflix (bottom). Pacing: word or phrase. translateTo adds a bilingual translated 2nd line. variantLang switches the MAIN caption line to a transcript translation variant (create it first with manage_transcript translate) — the variant only swaps text, timing stays the source\'s.',
    input_schema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        template: { type: 'string', enum: ['plain', 'tiktok', 'netflix'] },
        pacing: { type: 'string', enum: ['word', 'phrase'] },
        track: { type: 'string', description: 'Source track alias or stable id whose transcript drives captions (default A1).' },
        translateTo: { type: 'string', description: 'Also generate a translated 2nd caption line in this language (e.g. "中文", "English", "日本語").' },
        variantLang: { type: 'string', description: 'Display this transcript variant\'s language as the MAIN caption text (must already exist via manage_transcript translate). Pass "" to clear and show the source words again.' },
      },
    },
  },
];

export const TRANSCRIPT_TOOL_NAMES = new Set(TRANSCRIPT_TOOL_SCHEMAS.map((t) => t.name));

type Args = Record<string, unknown>;

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, ' ').trim();
}

// Locate a phrase in the word list; returns the covering [start, start+count) run.
function findPhrase(words: TranscriptWord[], query: string): { start: number; count: number } | null {
  const q = normalize(query);
  if (!q) return null;
  let joined = '';
  const charWord: number[] = [];
  words.forEach((w, i) => {
    const t = normalize(w.text);
    if (!t) return;
    if (joined) { joined += ' '; charWord.push(-1); }
    for (const ch of t) { joined += ch; charWord.push(i); }
  });
  const pos = joined.indexOf(q);
  if (pos < 0) return null;
  const s = charWord[pos];
  const e = charWord[pos + q.length - 1];
  if (s < 0 || e < 0) return null;
  return { start: s, count: e - s + 1 };
}

// audio clip on a track, optionally requiring an attached transcript
function trackClip(ctx: AgentContext, track: TrackId, needTranscript: boolean): TimelineItem | null {
  return ctx.getState().items.find((it) =>
    (it.kind === 'audio' || it.kind === 'video') && it.track === track && it.src && (!needTranscript || (it.transcript?.length ?? 0) > 0)) ?? null;
}

// Execute a transcript/caption tool. Returns undefined if `name` isn't one of ours.
export async function execTranscriptTool(name: string, args: Args, ctx: AgentContext): Promise<unknown | undefined> {
  const state = ctx.getState();
  const track = resolveTrackId(state, args.track ?? 'A1') ?? defaultTrackId(state, 'audio');
  if (!track) return { error: 'no track available; create one with edit_track first' };
  const alias = trackAlias(state, track);
  switch (name) {
    case 'transcribe_track': {
      // Transcribe ALL audio/video clips on the track (not just the first).
      const clips = ctx.getState().items
        .filter((it) => (it.kind === 'audio' || it.kind === 'video') && it.track === track && it.src)
        .sort((a, b) => a.startFrame - b.startFrame);
      if (!clips.length) return { error: `no audio/video clip on ${alias}` };
      const results: { itemId: string; words: number; text: string; skipped?: boolean }[] = [];
      try {
        for (const it of clips) {
          if (it.transcript?.length) {
            results.push({ itemId: it.id, words: it.transcript.length, text: '', skipped: true });
            continue;
          }
          const r = await transcribePath(it.src!, undefined, { languageCode: 'zh' });
          ctx.commands.setItemTranscript(it.id, r.words);
          results.push({ itemId: it.id, words: r.words.length, text: r.text.slice(0, 200) });
        }
        return { ok: true, track: alias, clips: results.length, results };
      } catch (e) {
        return { error: `transcription failed: ${e instanceof Error ? e.message : String(e)}`, partial: results };
      }
    }
    case 'find_transcript': {
      const it = trackClip(ctx, track, true);
      if (!it?.transcript) return { error: `no transcript on ${alias}; call transcribe_track first` };
      const m = findPhrase(it.transcript, String(args.query ?? ''));
      if (!m) return { found: false, query: args.query };
      const fps = ctx.getState().fps;
      const slice = it.transcript.slice(m.start, m.start + m.count);
      return {
        found: true, itemId: it.id, wordStart: m.start, wordCount: m.count,
        text: slice.map((w) => w.text).join(' '),
        fromFrame: it.startFrame + msToFrame(slice[0].start, fps),
        toFrame: it.startFrame + msToFrame(slice[slice.length - 1].end, fps),
      };
    }
    case 'clean_script': {
      const it = trackClip(ctx, track, true);
      if (!it?.transcript) return { error: `no transcript on ${alias}; call transcribe_track first` };
      const fps = ctx.getState().fps;
      const silenceFrames = typeof args.maxPauseSeconds === 'number' ? Math.max(1, Math.round(args.maxPauseSeconds * fps)) : undefined;
      const removeFillers = args.removeFillers !== false;
      ctx.commands.cleanScript(it.id, { silenceFrames, removeFillers });
      return { ok: true, itemId: it.id, maxPauseSeconds: (args.maxPauseSeconds as number) ?? null, fillersRemoved: removeFillers ? fillerIndices(it.transcript).length : 0 };
    }
    case 'delete_text': {
      const it = trackClip(ctx, track, true);
      if (!it?.transcript) return { error: `no transcript on ${alias}; call transcribe_track first` };
      const m = findPhrase(it.transcript, String(args.query ?? ''));
      if (!m) return { deleted: false, query: args.query, note: 'phrase not found' };
      const idxs = Array.from({ length: m.count }, (_, k) => m.start + k);
      const text = it.transcript.slice(m.start, m.start + m.count).map((w) => w.text).join(' ');
      ctx.commands.deleteWords(it.id, idxs);
      return { ok: true, itemId: it.id, deletedWords: m.count, text };
    }
    case 'edit_captions': {
      const s = ctx.getState();
      if (args.enabled === false) {
        if (s.captions) ctx.commands.updateCaptions({ enabled: false });
        return { ok: true, enabled: false };
      }
      const it = trackClip(ctx, track, true);
      if (!s.captions && !it?.transcript) return { error: `no transcript on ${alias}; call transcribe_track first (captions need a transcript source)` };
      const template = (args.template as CaptionTemplate) ?? s.captions?.template ?? 'tiktok';
      const pacing = (args.pacing as CaptionPacing) ?? s.captions?.pacing ?? 'phrase';
      const base: CaptionsData = { ...(s.captions ?? {}), enabled: true, template, pacing, ...(it ? { sourceItemId: it.id } : {}) };
      // variantLang: pick a transcript translation VARIANT as the MAIN caption text
      // (""/whitespace clears → show source). Only meaningful on the single-source path.
      let variant: string | null = null;
      if (typeof args.variantLang === 'string') {
        const vl = args.variantLang.trim();
        if (!vl) {
          base.captionVariantId = undefined;
        } else {
          const v = it?.variants ? findVariantByLang(it.variants, vl) : undefined;
          if (!v) return { error: `no transcript variant "${vl}" on ${alias}; run manage_transcript translate first` };
          base.captionVariantId = v.id;
          variant = v.lang;
        }
      }
      let translatedTo: string | null = null;
      if (args.translateTo) {
        try {
          const cues = await buildTranslation(base, s.items, s.fps, String(args.translateTo));
          base.translation = cues;
          base.translationLang = String(args.translateTo);
          base.bilingual = true;
          translatedTo = String(args.translateTo);
        } catch (e) {
          return { error: `translation failed: ${e instanceof Error ? e.message : String(e)}` };
        }
      }
      if (s.captions) ctx.commands.updateCaptions(base);
      else ctx.commands.setCaptions(base);
      return { ok: true, enabled: true, template, pacing, source: it ? trackAlias(ctx.getState(), it.track) : null, sourceTrackId: it?.track ?? null, translatedTo, variant };
    }
    case 'manage_transcript': {
      const action = args.action;
      // 定位 clip:优先 itemId,否则取该 track 上第一个带转写的 clip(fix/renameSpeaker 共用)
      const items = ctx.getState().items;
      const it = args.itemId ? items.find((x) => x.id === args.itemId) : trackClip(ctx, track, true);
      if (!it) return { error: args.itemId ? `no item ${String(args.itemId)}` : `no transcribed clip on ${alias}; call transcribe_track first` };
      if (!it.transcript?.length) return { error: `item ${it.id} has no transcript; call transcribe_track first` };

      if (action === 'renameSpeaker') {
        // 说话人重命名/合并:from→to。同机制覆盖重命名与合并(to 为已有标签即合并)。
        const from = args.from;
        const to = args.to;
        if (typeof from !== 'string' || !from.trim()) return { error: 'from is required (the existing speaker label)' };
        if (typeof to !== 'string' || !to.trim()) return { error: 'to is required (the new speaker name)' };
        const wordsChanged = it.transcript.filter((w) => w.speaker === from).length;
        if (wordsChanged === 0) return { error: `no word labeled speaker "${from}" in item ${it.id}` };
        // 护城河③:命令只改 .speaker,text/timing/词数/时长不变
        ctx.commands.renameSpeaker(it.id, from, to);
        return { ok: true, itemId: it.id, from, to, wordsChanged };
      }

      if (action === 'fix') {
        const text = args.text;
        if (typeof text !== 'string' || !text.trim()) return { error: 'text is required (the corrected word)' };
        // 定位词:wordIndex 优先,否则 find 精确匹配(先原文,再归一化容错标点/大小写)
        let wordIndex: number;
        if (typeof args.wordIndex === 'number') {
          wordIndex = args.wordIndex;
        } else if (typeof args.find === 'string' && args.find.trim()) {
          const findStr = args.find;
          wordIndex = it.transcript.findIndex((w) => w.text === findStr);
          if (wordIndex < 0) {
            const target = normalize(findStr);
            wordIndex = it.transcript.findIndex((w) => normalize(w.text) === target);
          }
          if (wordIndex < 0) return { error: `word not found: ${findStr}` };
        } else {
          return { error: 'provide wordIndex or find to locate the word' };
        }
        const word = it.transcript[wordIndex];
        if (!word) return { error: `wordIndex ${wordIndex} out of range (0..${it.transcript.length - 1})` };
        const from = word.text;
        // 护城河③:命令只改 .text,timing/词数/时长不变
        ctx.commands.fixTranscriptWord(it.id, wordIndex, text);
        return { ok: true, itemId: it.id, wordIndex, from, to: text };
      }

      if (action === 'translate') {
        // 翻译变体:整段转写翻成 lang,生成一个"文本变体"(词级,共享同一时间轴)。
        // 护城河③:变体只承载译文;每个变体词按源词下标 i 键,timing 一律取自源词
        // (见 resolveVariantText),翻译永远不重排或移动词的帧位。
        const lang = args.lang;
        if (typeof lang !== 'string' || !lang.trim()) return { error: 'lang is required (target language, e.g. "English")' };
        const langTrim = lang.trim();
        const force = args.force === true;
        const existing = findVariantByLang(it.variants, langTrim, 'translation');
        if (existing && !force) {
          return { ok: true, itemId: it.id, variantId: existing.id, lang: existing.lang, words: existing.words.length, reused: true };
        }
        try {
          const texts = await translateLines(it.transcript.map((w) => w.text), langTrim);
          const words = texts.map((text, i) => ({ i, text }));
          // force+existing → 复用同 id 覆盖;否则新建
          const variant = createVariant({ lang: langTrim, kind: 'translation', words, id: existing?.id });
          ctx.commands.setItemVariants(it.id, upsertVariant(it.variants, variant));
          return { ok: true, itemId: it.id, variantId: variant.id, lang: variant.lang, words: variant.words.length, reused: false };
        } catch (e) {
          return { error: `translation failed: ${e instanceof Error ? e.message : String(e)}` };
        }
      }

      return { error: `unsupported action: ${String(action)}; use "fix", "renameSpeaker" or "translate"` };
    }
    default:
      return undefined;
  }
}
