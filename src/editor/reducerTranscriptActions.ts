import type { TimelineItem, TimelineState } from './types';
import { hasOperationalTranscript } from '../transcript/types';
import { newTranscriptGeneration } from '../transcript/identity';
import { fillerIndices } from '../transcript/edit';
import type { Action } from './reducerActions';
import { editedDuration } from './reducerTimelineHelpers';

export function applyTranscriptAction(s: TimelineState, a: Action): TimelineState | undefined {
  switch (a.type) {
    case 'setItemTranscript':
      return {
        ...s,
        items: s.items.map((it) =>
          it.id === a.id
            ? {
                ...it,
                ...newTranscriptGeneration(a.words),
                transcriptStale: false,
                srcInFrame: it.transcriptStale === true ? 0 : it.srcInFrame,
                deletedWordIdx: [],
                silenceFrames: undefined,
                gapCapsMs: undefined,
                transcriptPlayOrder: undefined,
                cutPadFrames: undefined,
                variants: undefined,
              }
            : it,
        ),
      };
    case 'setItemVariants':
      // Replace the item's text-only transcript variants. Purely additive metadata:
      // it touches neither transcript words, timings, nor durationInFrames.
      return hasOperationalTranscript(s.items.find((it) => it.id === a.id))
        ? { ...s, items: s.items.map((it) => (it.id === a.id ? { ...it, variants: a.variants } : it)) }
        : s;
    case 'toggleWord':
      if (!hasOperationalTranscript(s.items.find((it) => it.id === a.id))) return s;
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== a.id) return it;
          const del = new Set(it.deletedWordIdx ?? []);
          if (del.has(a.idx)) del.delete(a.idx);
          else del.add(a.idx);
          return { ...it, deletedWordIdx: [...del], durationInFrames: editedDuration(it, del, s.fps) };
        }),
      };
    case 'deleteWords':
      if (!hasOperationalTranscript(s.items.find((it) => it.id === a.id))) return s;
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== a.id) return it;
          const del = new Set(it.deletedWordIdx ?? []);
          for (const idx of a.idxs) if (idx >= 0 && idx < it.transcript!.length) del.add(idx);
          return { ...it, deletedWordIdx: [...del], durationInFrames: editedDuration(it, del, s.fps) };
        }),
      };
    case 'cleanScript':
      if (!hasOperationalTranscript(s.items.find((it) => it.id === a.id))) return s;
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== a.id) return it;
          const del = new Set(it.deletedWordIdx ?? []);
          if (a.removeFillers) for (const idx of fillerIndices(it.transcript!)) del.add(idx);
          const next = {
            ...it,
            deletedWordIdx: [...del],
            silenceFrames: a.replaceGapCaps ? undefined : a.silenceFrames,
            gapCapsMs: a.replaceGapCaps ? a.gapCapsMs : it.gapCapsMs,
            cutPadFrames: a.cutPadFrames === undefined ? it.cutPadFrames : Math.max(0, Math.round(a.cutPadFrames)),
          };
          return { ...next, durationInFrames: editedDuration(next, del, s.fps) };
        }),
      };
    case 'setGapCap': {
      const it = s.items.find((x) => x.id === a.id);
      if (!hasOperationalTranscript(it) || a.afterWordIndex < 0 || a.afterWordIndex >= it.transcript.length) return s;
      const key = String(a.afterWordIndex);
      const prev = it.gapCapsMs ?? {};
      let nextCaps: Record<string, number> | undefined;
      if (a.maxMs == null) {
        if (!(key in prev)) return s;
        const { [key]: _, ...rest } = prev;
        nextCaps = Object.keys(rest).length ? rest : undefined;
      } else {
        const ms = Math.max(0, Math.round(a.maxMs));
        if (prev[key] === ms) return s;
        nextCaps = { ...prev, [key]: ms };
      }
      return {
        ...s,
        items: s.items.map((item) => {
          if (item.id !== a.id) return item;
          const del = new Set(item.deletedWordIdx ?? []);
          const next = { ...item, gapCapsMs: nextCaps };
          return { ...next, durationInFrames: editedDuration(next, del, s.fps) };
        }),
      };
    }
    case 'setTranscriptPlayOrder': {
      const it = s.items.find((x) => x.id === a.id);
      if (!hasOperationalTranscript(it)) return s;
      const playOrder = a.playOrder;
      if (playOrder == null) {
        if (!it.transcriptPlayOrder?.length) return s;
        const next = { ...it, transcriptPlayOrder: undefined };
        const del = new Set(it.deletedWordIdx ?? []);
        return {
          ...s,
          items: s.items.map((item) =>
            item.id === a.id ? { ...next, durationInFrames: editedDuration(next, del, s.fps) } : item,
          ),
        };
      }
      // validate: permutation of existing indices (allow subset of non-deleted)
      const n = it.transcript.length;
      const cleaned = playOrder.filter((i) => Number.isInteger(i) && i >= 0 && i < n);
      if (!cleaned.length) return s;
      const next = { ...it, transcriptPlayOrder: cleaned };
      const del = new Set(it.deletedWordIdx ?? []);
      return {
        ...s,
        items: s.items.map((item) =>
          item.id === a.id ? { ...next, durationInFrames: editedDuration(next, del, s.fps) } : item,
        ),
      };
    }
    case 'reorderTrackItems': {
      const onTrack = s.items.filter((it) => it.track === a.track);
      if (onTrack.length < 2) return s;
      const byId = new Map(onTrack.map((it) => [it.id, it]));
      const ordered = a.orderedIds.map((id) => byId.get(id)).filter((x): x is TimelineItem => !!x);
      if (ordered.length < 2) return s;
      const starts = new Map<string, number>();
      if (a.starts) {
        // Explicit gap-aware repack (apply_script): absolute frames, atomic
        // dispatch so the same-track overlap guard never sees an intermediate
        // overlapping state. Items without a pinned start keep their position.
        // This is an LLM-facing channel: any non-finite or negative pinned
        // start rejects the whole action (atomic semantics — no partial repack).
        for (const it of ordered) {
          const pinned = a.starts[it.id];
          if (pinned === undefined) continue;
          if (!Number.isFinite(pinned) || pinned < 0) return s;
          starts.set(it.id, Math.round(pinned));
        }
      } else {
        // Pack from the earliest of the reordered set so the block stays in place.
        let t = Math.min(...ordered.map((it) => it.startFrame));
        for (const it of ordered) {
          starts.set(it.id, t);
          t += Math.max(1, it.durationInFrames);
        }
      }
      return {
        ...s,
        items: s.items.map((it) =>
          starts.has(it.id) ? { ...it, startFrame: starts.get(it.id)! } : it,
        ),
      };
    }
    case 'clearEdits': {
      if (!hasOperationalTranscript(s.items.find((it) => it.id === a.id))) return s;
      return {
        ...s,
        items: s.items.map((it) =>
          it.id === a.id ? { ...it, deletedWordIdx: [], silenceFrames: undefined, gapCapsMs: undefined, transcriptPlayOrder: undefined, durationInFrames: editedDuration(it, new Set(), s.fps) } : it,
        ),
      };
    }
    case 'fixTranscriptWord': {
      // Correct typos: Only correct the text of a transliterated word to keep the word frame consistent in both directions - only replace .text,
      // The start/end (frame bit), speaker, number of words, and durationInFrames of the clip are all unchanged.
      const it = s.items.find((x) => x.id === a.id);
      if (!hasOperationalTranscript(it)) return s;
      const word = it.transcript[a.wordIndex];
      // Out of bounds / No current transcript / Text unchanged → True no-op (return to original state, do not enter the history stack)
      if (!word || word.text === a.text) return s;
      return {
        ...s,
        items: s.items.map((item) =>
          item.id === a.id
            ? { ...item, transcript: item.transcript!.map((w, i) => (i === a.wordIndex ? { ...w, text: a.text } : w)) }
            : item,
        ),
      };
    }
    case 'renameSpeaker': {
      // Speaker renaming/merging: Rename all words with speaker===from to to, and keep the word frame consistent —
      // Only change word.speaker, text/start/end, number of words, clip duration, all unchanged; from→to covered by the same mechanism
      // Rename ('A'→'Host') and merge ('B'→'A', two speakers collapse into one).
      // Note: TimelineItem only stores transcript (word), and there is no utterances/segment field to change.
      const it = s.items.find((x) => x.id === a.id);
      // No item / No transliteration / Speaker without words ===from → true no-op (return to original state, do not enter the history stack)
      if (!hasOperationalTranscript(it) || !it.transcript.some((w) => w.speaker === a.from)) return s;
      return {
        ...s,
        items: s.items.map((item) =>
          item.id === a.id
            ? { ...item, transcript: item.transcript!.map((w) => (w.speaker === a.from ? { ...w, speaker: a.to } : w)) }
            : item,
        ),
      };
    }
    case 'setItemDenoise': {
      const it = s.items.find((x) => x.id === a.id);
      if (!it || (it.kind !== 'audio' && it.kind !== 'video')) return s;
      // clear
      if (!a.denoisedSrc) {
        if (!it.denoisedSrc) return s;
        return {
          ...s,
          items: s.items.map((item) =>
            item.id === a.id ? { ...item, denoisedSrc: null, denoiseStrength: null } : item,
          ),
        };
      }
      const nextStrength = a.strength ?? 100;
      if (it.denoisedSrc === a.denoisedSrc && (it.denoiseStrength ?? 100) === nextStrength) return s;
      return {
        ...s,
        items: s.items.map((item) =>
          item.id === a.id
            ? {
                ...item,
                denoisedSrc: a.denoisedSrc,
                denoiseStrength: nextStrength,
              }
            : item,
        ),
      };
    }
    default:
      return undefined;
  }
}
