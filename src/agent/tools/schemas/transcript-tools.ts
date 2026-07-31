import type { AgentToolSchema } from '../../tool-schema';

export const TRANSCRIPT_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'read_transcript',
    description: 'Read the current timeline transcript as a compact phrase view for planning and semantic editing. This is the default transcript reading surface for long videos and multiple takes: words are grouped by speaker changes, pauses, and a bounded phrase size while retaining source item, source timestamps, timeline frames, and original word-index ranges. Deleted/trimmed words are omitted, but the word-level transcript remains unchanged for precise edits. Use find_transcript when locating a specific quote instead.',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Optional clip id or unique prefix. Omit to read all transcribed clips.' },
        track: { type: 'string', description: 'Optional track alias/id. Ignored when itemId is set.' },
        silenceThresholdSeconds: { type: 'number', minimum: 0, maximum: 10, description: 'Start a new phrase after this pause; defaults to 0.5 seconds.' },
        maxWordsPerPhrase: { type: 'integer', minimum: 1, maximum: 100, description: 'Hard cap for uninterrupted speech; defaults to 40 words.' },
        offset: { type: 'integer', minimum: 0, description: 'Phrase offset for pagination; defaults to 0.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum phrases to return; defaults to 80.' },
      },
    },
  },
  {
    name: 'transcribe_track',
    description: 'Transcribe the audio clip on a track (word-level + speaker labels, via AssemblyAI) and attach the transcript. Required before find_transcript / clean_script / delete_text / captions when the clip has no transcript yet.',
    input_schema: { type: 'object', properties: { track: { type: 'string', description: 'Track alias or stable id whose audio to transcribe (default A1).' } } },
  },
  {
    name: 'search_media',
    description: 'Search project media through one typed surface. Returns visual ChineseCLIP scene hits and spoken transcript hits with normalized per-modality scores, source time ranges, asset ids, and source revisions. Results are grouped by modality because cosine and transcript scores are not directly comparable; stale derived hits are excluded.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Visual concept or spoken phrase to find.' },
        modalities: {
          type: 'array',
          items: { type: 'string', enum: ['visual', 'spoken'] },
          description: 'Optional subset; defaults to both visual and spoken.',
        },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum hits per modality; defaults to 12.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'find_transcript',
    description: 'Find WHEN a phrase is spoken — a time-coordinate lookup, not a transcript reader or editing tool. Returns matches with their timeline frame range (fromFrame/toFrame) so you can anchor B-roll, motion graphics, markers, or overlays at that moment (or locate a spot before delete_text). Default: contiguous case/punctuation/whitespace-insensitive match over every transcribed clip on the timeline; edits are respected (deleted words won\'t match). asset = search ONE asset\'s raw transcript regardless of timeline use (library lookup, ignores edits). track = restrict to that track. fuzzy = token-order match with window tolerance (use when ASR may have fillers like "uh," between query tokens). includeWordTimestamps = add a Words block under each match with each word\'s start → end time — use when syncing animation beats to which word is being said; skip for plain phrase anchoring (extra output). limit = max results (default 10).',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for.' },
        asset: { type: 'string', description: 'Asset ID or prefix ID. Omit to search across the whole project.' },
        track: { type: 'string', description: 'Track alias (V1/A1/...) or track id. Restricts the search to that track.' },
        fuzzy: { type: 'boolean', description: 'Token-window match (tolerates fillers between tokens).' },
        includeWordTimestamps: { type: 'boolean', description: 'Include per-word timestamps inside each match (default false). Adds a Words block under each match with each word\'s start -> end time. Use when syncing animation beats to speech cadence (e.g., MG internal rhythm matched to which word is being said).' },
        limit: { type: 'integer', description: 'Max results returned (default 10).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'clean_script',
    description: 'Mechanically clean transcribed clips with fixed filler removal and typed pause rules. only may be "fillers", "silence", or "fillers,silence". silence accepts compress:400, restore:500, normalize:500, range:300-800, plus legacy max:400, min:500, 500, and min:300,max:800. Rules that lengthen a pause never exceed the silence present in the recording. Existing maxPauseSeconds/removeFillers calls remain supported. The whole operation is one undo step.',
    input_schema: {
      type: 'object',
      properties: {
        track: { type: 'string', description: 'Track alias/id whose voiceover clips to clean (default A1). Cleans every transcribed clip on it.' },
        itemId: { type: 'string', description: 'Optional: clean only this one clip instead of the whole track.' },
        only: { type: 'string', description: 'Run fillers, silence, or both as fillers,silence. Omit for existing default behavior.' },
        silence: { type: 'string', description: 'Pause rule: compress:400, restore:500, normalize:500, range:300-800, or legacy syntax.' },
        longSilence: { type: 'number', description: 'Long-pause threshold in ms for the default silence rule (pauses at/above it compress to 200ms). Default 3000 when only includes silence and no silence rule is supplied.' },
        maxPauseSeconds: { type: 'number', description: 'Compress pauses longer than this down to it (e.g. 0.5). Omit to leave pauses.' },
        removeFillers: { type: 'boolean', description: 'Strip filler words (default true).' },
        cutPadMs: { type: 'number', minimum: 0, maximum: 500, description: 'Breathing room kept around each word cut, split between the two sides (e.g. 150). Borrowed from silence already in the recording, so it never bleeds into a neighbouring word. 0 or omitted cuts exactly on the word boundary.' },
      },
    },
  },
  {
    name: 'edit_gap',
    description:
      'List or edit breath/silence gaps between spoken words on a transcribed clip. Gaps are computed from word timestamps (next.start − prev.end), not separate assets. action=list returns visible gaps with afterWordIndex/gapSeconds/context. action=delete removes one gap (silence→0, later audio ripples earlier). action=cap compresses one gap to maxSeconds (e.g. 0.2). action=restore clears a per-gap override so the original pause returns. Prefer list first to get afterWordIndex. For batch whole-track pause cleanup use clean_script instead.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'delete', 'cap', 'restore'],
          description: 'list=enumerate gaps; delete=remove one gap; cap=compress one gap; restore=undo per-gap override.',
        },
        track: { type: 'string', description: 'Track alias/id (default A1) when itemId omitted.' },
        itemId: { type: 'string', description: 'Target clip id (prefix ok). Prefer when multiple clips share a track.' },
        afterWordIndex: {
          type: 'number',
          description: 'Word index AFTER the gap (from list). Required for delete/cap/restore unless afterText is given.',
        },
        afterText: {
          type: 'string',
          description: 'Locate gap by the spoken phrase that STARTS after the gap (matched in transcript). Alternative to afterWordIndex.',
        },
        gapIndex: {
          type: 'number',
          description: '0-based index among listable gaps on the clip (from list). Alternative to afterWordIndex.',
        },
        maxSeconds: {
          type: 'number',
          description: 'cap only: max pause seconds to keep (e.g. 0.2 or 0.5). Required for cap.',
        },
        minGapSeconds: {
          type: 'number',
          description: 'list only: min raw gap to include (default 0.25s).',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'delete_text',
    description: 'Delete a spoken phrase from a track — "delete text = delete video": the matching words\' audio and their time are cut and the clip re-times. If unsure of the exact wording, find_transcript first. ⚠ AUDIO clips only re-time this way; a VIDEO clip always plays continuously from srcInFrame — deleting its words cuts NOTHING (captions keep mirroring the audible speech, so the deletion has no visible effect). To cut a video clip use split_item / edit_item (srcInFrame + durationInFrames); to hide individual words from captions use edit_captions action=display_text.',
    input_schema: { type: 'object', properties: { track: { type: 'string' }, query: { type: 'string', description: 'The phrase to delete (matched against the transcript).' } }, required: ['query'] },
  },
  {
    name: 'manage_transcript',
    description: 'Correct source transcripts and manage translation variants without changing the timeline; word timing, frame positions, word count, and clip duration remain unchanged. Six actions:\n'
      + '- fix: correct the source transcript. For a word, pass wordIndex or find with the incorrect source text plus text with the correction; only word.text changes. To rename or merge a speaker, pass from with an existing label such as "A" plus to with the new display name; passing another existing label merges them. Only word.speaker changes.\n'
      + '- retry_transcription: force ASR to rerun for the clip and replace its transcript when transcription is stuck, failed, or needs refreshing.\n'
      + '- translation_create: translate the full transcript to lang and create or replace a word-level translation variant sharing the source timeline.\n'
      + '- translation_ensure: idempotently reuse an existing variant for lang or create it otherwise. Prefer this for ordinary translation requests.\n'
      + '- translation_list: list the source transcript and all translation variants with id/lang/word count.\n'
      + '- translation_read: read words from a translation variant selected by lang or targetLanguage.\n'
      + 'Translation variants contain translated text only. To display a language in captions, use edit_captions language_mode.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['fix', 'retry_transcription', 'translation_create', 'translation_ensure', 'translation_list', 'translation_read'], description: 'See the tool description: correct words/speakers, rerun ASR, or create/ensure/list/read translation variants.' },
        itemId: { type: 'string', description: 'Target clip item id; omit to use the first transcribed audio/video clip on the track.' },
        track: { type: 'string', description: 'When itemId is omitted, locate by track alias or stable id; default A1.' },
        wordIndex: { type: 'number', description: 'fix word: index of the word to correct; mutually exclusive with find.' },
        find: { type: 'string', description: 'fix word: incorrect source text that must match exactly one word; mutually exclusive with wordIndex.' },
        text: { type: 'string', description: 'fix word: corrected text.' },
        from: { type: 'string', description: 'fix speaker: existing speaker label to rename, such as "A" or "B".' },
        to: { type: 'string', description: 'fix speaker: new display name; passing an existing label merges the speakers, for example "B" to "A".' },
        lang: { type: 'string', description: 'translation_create/ensure: target language, such as English, Chinese, or Japanese; translation_read: variant language to read.' },
        targetLanguage: { type: 'string', description: 'translation_read: alias of lang for selecting the translated language.' },
      },
      required: ['action'],
    },
  },
];

export const TRANSCRIPT_TOOL_NAMES = new Set(TRANSCRIPT_TOOL_SCHEMAS.map((t) => t.name));
