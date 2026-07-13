import Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from './context';
import type { TimelineItem, TrackId } from '../editor/types';
import type { TranscriptWord } from '../transcript/types';
import { msToFrame } from '../transcript/types';
import { transcribePath } from '../transcript/assemblyai';
import { fillerIndices } from '../transcript/edit';
import type { CaptionTemplate, CaptionPacing, CaptionsData } from '../captions/types';
import { buildTranslation } from '../captions/translate';

// Agent tools for the transcript / caption / "delete text = delete video" surface.
// Names + semantics mirror ChatCut's real tools (see chatcut-reverse
// 复刻规格-Agent工具与后端.md): transcribe (import_media/manage_transcript),
// find_transcript, clean_script, delete_text (apply_script), edit_captions.

const TRACK_ENUM = ['A1', 'A2', 'V1', 'V2'];

export const TRANSCRIPT_TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'transcribe_track',
    description: 'Transcribe the audio clip on a track (word-level + speaker labels, via AssemblyAI) and attach the transcript. Required before find_transcript / clean_script / delete_text / captions when the clip has no transcript yet.',
    input_schema: { type: 'object', properties: { track: { type: 'string', enum: TRACK_ENUM, description: 'Track whose audio clip to transcribe (default A1).' } } },
  },
  {
    name: 'find_transcript',
    description: 'Find where a phrase is spoken in a track\'s transcript. Returns the matching words and their timeline frame range (fromFrame/toFrame). Use to locate a spot before inserting B-roll/MG or before delete_text.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, track: { type: 'string', enum: TRACK_ENUM } }, required: ['query'] },
  },
  {
    name: 'clean_script',
    description: 'Mechanically clean a track\'s voiceover: compress long pauses to a target length and/or strip filler words (um/uh/嗯/呃). Rule-based on word timings (not the LLM); the clip shortens accordingly. Run before semantic editing.',
    input_schema: {
      type: 'object',
      properties: {
        track: { type: 'string', enum: TRACK_ENUM },
        maxPauseSeconds: { type: 'number', description: 'Compress pauses longer than this down to it (e.g. 0.5). Omit to leave pauses.' },
        removeFillers: { type: 'boolean', description: 'Strip filler words (default true).' },
      },
    },
  },
  {
    name: 'delete_text',
    description: 'Delete a spoken phrase from a track — "delete text = delete video": the matching words\' audio and their time are cut and the clip re-times. If unsure of the exact wording, find_transcript first.',
    input_schema: { type: 'object', properties: { track: { type: 'string', enum: TRACK_ENUM }, query: { type: 'string', description: 'The phrase to delete (matched against the transcript).' } }, required: ['query'] },
  },
  {
    name: 'edit_captions',
    description: 'Turn the captions overlay on/off and set its style. Captions are a single overlay that mirrors a track\'s transcript and follow edits automatically. Templates: plain, tiktok (big karaoke), netflix (bottom). Pacing: word or phrase. translateTo adds a bilingual translated 2nd line.',
    input_schema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        template: { type: 'string', enum: ['plain', 'tiktok', 'netflix'] },
        pacing: { type: 'string', enum: ['word', 'phrase'] },
        track: { type: 'string', enum: TRACK_ENUM, description: 'Source track whose transcript drives captions (default A1).' },
        translateTo: { type: 'string', description: 'Also generate a translated 2nd caption line in this language (e.g. "中文", "English", "日本語").' },
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
    it.kind === 'audio' && it.track === track && it.src && (!needTranscript || (it.transcript?.length ?? 0) > 0)) ?? null;
}

// Execute a transcript/caption tool. Returns undefined if `name` isn't one of ours.
export async function execTranscriptTool(name: string, args: Args, ctx: AgentContext): Promise<unknown | undefined> {
  const track = (args.track as TrackId) ?? 'A1';
  switch (name) {
    case 'transcribe_track': {
      const it = trackClip(ctx, track, false);
      if (!it) return { error: `no audio clip on ${track}` };
      if (it.transcript?.length) return { ok: true, itemId: it.id, words: it.transcript.length, note: 'already transcribed' };
      try {
        const r = await transcribePath(it.src!);
        ctx.commands.setItemTranscript(it.id, r.words);
        return { ok: true, itemId: it.id, words: r.words.length, text: r.text.slice(0, 400) };
      } catch (e) {
        return { error: `transcription failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    case 'find_transcript': {
      const it = trackClip(ctx, track, true);
      if (!it?.transcript) return { error: `no transcript on ${track}; call transcribe_track first` };
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
      if (!it?.transcript) return { error: `no transcript on ${track}; call transcribe_track first` };
      const fps = ctx.getState().fps;
      const silenceFrames = typeof args.maxPauseSeconds === 'number' ? Math.max(1, Math.round(args.maxPauseSeconds * fps)) : undefined;
      const removeFillers = args.removeFillers !== false;
      ctx.commands.cleanScript(it.id, { silenceFrames, removeFillers });
      return { ok: true, itemId: it.id, maxPauseSeconds: (args.maxPauseSeconds as number) ?? null, fillersRemoved: removeFillers ? fillerIndices(it.transcript).length : 0 };
    }
    case 'delete_text': {
      const it = trackClip(ctx, track, true);
      if (!it?.transcript) return { error: `no transcript on ${track}; call transcribe_track first` };
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
      if (!s.captions && !it?.transcript) return { error: `no transcript on ${track}; call transcribe_track first (captions need a transcript source)` };
      const template = (args.template as CaptionTemplate) ?? s.captions?.template ?? 'tiktok';
      const pacing = (args.pacing as CaptionPacing) ?? s.captions?.pacing ?? 'phrase';
      const base: CaptionsData = { ...(s.captions ?? {}), enabled: true, template, pacing, ...(it ? { sourceItemId: it.id } : {}) };
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
      return { ok: true, enabled: true, template, pacing, source: it?.track ?? null, translatedTo };
    }
    default:
      return undefined;
  }
}
