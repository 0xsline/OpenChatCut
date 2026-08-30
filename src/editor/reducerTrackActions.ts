import type { TimelineItem, TimelineState, TrackFlags, TransitionItem } from './types';
import { captionTrackEntries, captionsOnTrack, DEFAULT_WATERMARK, defaultTrackId, isAudioTransition, timelineTrackIds, trackEnd, trackKind } from './types';
import { reconcileTimelineCaptionReferences } from '../captions/reconcileSources.js';
import type { Action } from './reducerActions';
import { placeTrack, withTrackCaptions } from './reducerTimelineHelpers';

export function applyTrackAction(
  s: TimelineState,
  a: Action,
  reduceTimeline: (state: TimelineState, action: Action) => TimelineState,
): TimelineState | undefined {
  switch (a.type) {
    case 'addTransition': {
      const inItem = s.items.find((x) => x.id === a.incomingItemId);
      if (!inItem) return s;
      const audioTr = isAudioTransition(a.transType);
      // audio-cross-fade only on audio clips; visual transitions never on pure audio
      if (audioTr) {
        if (inItem.kind !== 'audio') return s;
      } else if (inItem.kind === 'audio') {
        return s;
      }
      // outgoing = same-track clip whose end sits adjacent to the incoming's start
      const prior = s.items.filter(
        (x) => x.id !== inItem.id
          && x.track === inItem.track
          && (audioTr ? x.kind === 'audio' : x.kind !== 'audio')
          && x.startFrame + x.durationInFrames <= inItem.startFrame + 2,
      );
      if (!prior.length) return s;
      const out = prior.reduce((best, x) => (x.startFrame + x.durationInFrames > best.startFrame + best.durationInFrames ? x : best));
      if (inItem.startFrame - (out.startFrame + out.durationInFrames) > 2) return s; // must be adjacent
      const maxL = Math.max(2, Math.min(out.durationInFrames, inItem.durationInFrames));
      const defaultL = audioTr ? Math.min(15, maxL) : Math.min(30, maxL);
      const L = Math.max(2, Math.min(a.durationInFrames ?? defaultL, maxL));
      const t: TransitionItem = {
        id: a.id, type: a.transType, durationInFrames: L, outgoingItemId: out.id, incomingItemId: inItem.id, trackId: inItem.track, enabled: true,
        // custom-shader: carry the generated GLSL onto the item so it persists + renders after reload
        ...(a.custom ? { customFrag: a.custom.frag, customUniforms: a.custom.uniforms, customLabel: a.custom.label } : {}),
      };
      const others = (s.transitions ?? []).filter((x) => x.incomingItemId !== inItem.id); // one in-transition per clip
      return { ...s, transitions: [...others, t] };
    }
    case 'addMarker':
      return { ...s, markers: [...(s.markers ?? []), a.marker] };
    case 'updateMarker': {
      // Symmetric with addMarker's command-side clamp: frame fields stay
      // non-negative integers or the patch is rejected whole.
      const { fromFrame, durationFrames } = a.patch;
      if ((fromFrame !== undefined && !Number.isFinite(fromFrame))
        || (durationFrames !== undefined && !Number.isFinite(durationFrames))) return s;
      const patch = {
        ...a.patch,
        ...(fromFrame !== undefined ? { fromFrame: Math.max(0, Math.round(fromFrame)) } : {}),
        ...(durationFrames !== undefined ? { durationFrames: Math.max(0, Math.round(durationFrames)) } : {}),
      };
      return { ...s, markers: (s.markers ?? []).map((m) => (m.id === a.id ? { ...m, ...patch } : m)) };
    }
    case 'removeMarker':
      return { ...s, markers: (s.markers ?? []).filter((m) => m.id !== a.id) };
    case 'setTransition':
      return {
        ...s,
        transitions: (s.transitions ?? []).map((t) => {
          if (t.id !== a.id) return t;
          const merged = { ...t, ...a.patch };
          if (a.patch.durationInFrames !== undefined) {
            // Cannot exceed either clip's length; this avoids freeze frames and overlap.
            const out = s.items.find((x) => x.id === t.outgoingItemId);
            const inc = s.items.find((x) => x.id === t.incomingItemId);
            const maxL = Math.max(2, Math.min(out?.durationInFrames ?? 2, inc?.durationInFrames ?? 2));
            merged.durationInFrames = Math.max(2, Math.min(merged.durationInFrames, maxL));
          }
          return merged;
        }),
      };
    case 'removeTransition':
      return { ...s, transitions: (s.transitions ?? []).filter((t) => t.id !== a.id) };
    case 'duplicate': {
      const it = s.items.find((x) => x.id === a.id);
      if (!it || !a.newId || s.items.some((item) => item.id === a.newId)
        || s.tracks?.[it.track]?.locked) return s;
      const copy: TimelineItem = { ...it, id: a.newId, props: { ...it.props }, startFrame: trackEnd(s, it.track) };
      return { ...s, items: [...s.items, copy], selectedId: copy.id, selectedIds: [copy.id] };
    }
    case 'clear':
      return reconcileTimelineCaptionReferences({
        ...s,
        items: [],
        selectedId: null,
        selectedIds: [],
        linkGroups: undefined,
        multicamGroups: undefined,
      });
    case 'setCanvas': {
      if (!Number.isFinite(a.width) || !Number.isFinite(a.height)) return s;
      const width = Math.round(a.width);
      const height = Math.round(a.height);
      // Zero/negative canvas would divide-by-zero nested sequence layout.
      if (width < 1 || height < 1) return s;
      return { ...s, width, height, fit: a.fit ?? s.fit ?? 'contain' };
    }
    case 'toggleTrack': {
      const trackCaptions = captionsOnTrack(s, a.track);
      if (a.flag === 'hidden' && trackKind(s, a.track) === 'caption' && trackCaptions) {
        return withTrackCaptions(s, { ...trackCaptions, enabled: !trackCaptions.enabled }, a.track);
      }
      const cur = s.tracks?.[a.track] ?? {};
      return { ...s, tracks: { ...s.tracks, [a.track]: { ...cur, [a.flag]: !cur[a.flag] } } };
    }
    case 'track.create': {
      const audioConfig = a.track.kind === 'caption'
        ? { role: undefined, audioRouting: undefined }
        : { role: a.track.role, audioRouting: a.track.audioRouting };
      return {
        ...s,
        trackOrder: placeTrack(s, a.track.id, a.track.kind, a.order),
        tracks: { ...s.tracks, [a.track.id]: { kind: a.track.kind, name: a.track.name, ...(a.track.kind === 'caption' ? { captions: null } : {}), ...audioConfig } },
      };
    }
    case 'track.update': {
      if (!timelineTrackIds(s).includes(a.track)) return s;
      const primaryCaption = defaultTrackId(s, 'caption');
      if (a.patch.order !== undefined && primaryCaption && s.tracks?.[primaryCaption]?.captions === undefined && s.captions) {
        return reduceTimeline(withTrackCaptions(s, s.captions, primaryCaption), a);
      }
      const current = s.tracks?.[a.track] ?? { kind: trackKind(s, a.track) };
      const { order, role, audioRouting, ...rest } = a.patch;
      const next: TrackFlags = { ...current, ...rest };
      const isCaption = trackKind(s, a.track) === 'caption';
      const captionHidden = isCaption && typeof rest.hidden === 'boolean' ? rest.hidden : undefined;
      if (role === null) delete next.role;
      else if (role !== undefined) next.role = role;
      if (audioRouting) {
        if (audioRouting.duckDepthDb === null) delete next.audioRouting;
        else next.audioRouting = { ...next.audioRouting, ...audioRouting } as TrackFlags['audioRouting'];
      }
      if (next.role !== 'follower') delete next.audioRouting;
      if (isCaption) {
        delete next.hidden;
        delete next.muted;
        delete next.role;
        delete next.audioRouting;
      }
      let trackOrder = timelineTrackIds(s);
      if (order !== undefined) {
        const kind = trackKind(s, a.track);
        trackOrder = placeTrack(s, a.track, kind, Math.round(order));
      }
      let nextState = { ...s, trackOrder, tracks: { ...s.tracks, [a.track]: next } };
      if (order !== undefined && isCaption) {
        const primary = defaultTrackId(nextState, 'caption');
        nextState = { ...nextState, captions: primary ? captionsOnTrack(nextState, primary) : null };
      }
      const trackCaptions = captionsOnTrack(s, a.track);
      return captionHidden === undefined || !trackCaptions
        ? nextState
        : withTrackCaptions(nextState, { ...trackCaptions, enabled: !captionHidden }, a.track);
    }
    case 'track.delete': {
      const remove = new Set(a.tracks);
      const ownsCaptions = [...remove].some((id) => !!captionsOnTrack(s, id));
      if (!remove.size || ownsCaptions || s.items.some((item) => remove.has(item.track)) || (s.transitions ?? []).some((transition) => remove.has(transition.trackId))) return s;
      const ids = timelineTrackIds(s);
      const remaining = ids.filter((id) => !remove.has(id));
      if (!remaining.some((id) => trackKind(s, id) === 'video')) return s;
      const tracks = { ...s.tracks };
      for (const id of remove) delete tracks[id];
      const next = { ...s, trackOrder: remaining, tracks };
      const primary = defaultTrackId(next, 'caption');
      return { ...next, captions: primary ? captionsOnTrack(next, primary) : null };
    }
    case 'track.tighten': {
      if (s.tracks?.[a.track]?.locked) return s;
      const clips = s.items.filter((item) => item.track === a.track).sort((x, y) => x.startFrame - y.startFrame);
      if (clips.length < 2) return s;
      let cursor = clips[0].startFrame + clips[0].durationInFrames;
      const starts = new Map<string, number>();
      for (const clip of clips.slice(1)) {
        starts.set(clip.id, cursor);
        cursor += clip.durationInFrames;
      }
      return { ...s, items: s.items.map((item) => starts.has(item.id) ? { ...item, startFrame: starts.get(item.id)! } : item) };
    }
    case 'setCaptions':
      return withTrackCaptions(s, a.captions, a.track);
    case 'updateCaptions': {
      const target = a.track ?? defaultTrackId(s, 'caption') ?? undefined;
      const captions = target ? captionsOnTrack(s, target) : s.captions;
      return captions ? withTrackCaptions(s, { ...captions, ...a.patch }, target) : s;
    }
    case 'setCaptionsHidden': {
      // Global caption-system switch: captions off also hides on-screen text
      // clips (render layer). Keep every caption track's enabled in sync.
      let next: TimelineState = { ...s, captionsHidden: a.hidden };
      const targets = captionTrackEntries(next);
      if (targets.length) {
        for (const { id } of targets) {
          const base = captionsOnTrack(next, id) ?? s.captions
            ?? { enabled: true, template: 'plain' as const, pacing: 'phrase' as const };
          next = withTrackCaptions(next, { ...base, enabled: !a.hidden }, id);
        }
      }
      return next;
    }
    case 'updateWatermark': {
      // patch-merge over the current watermark (or defaults on first use); clamp
      // opacity at the boundary so a bad LLM value can't escape 0..1.
      const next = { ...(s.watermark ?? DEFAULT_WATERMARK), ...a.patch };
      return { ...s, watermark: { ...next, opacity: Math.max(0, Math.min(1, next.opacity)) } };
    }
    default:
      return undefined;
  }
}
