// Pure reducer layer: the per-timeline reducer (`reduce`) + the project reducer
// (`projectReduce`, routing per-timeline actions to the active timeline) + the
// undo/redo history wrapper. The command set + React hook live in store.ts.
import type { AspectFit, ClipEffect, ClipFilters, ClipTransform, DesignStyle, KeyframeEasing, KeyframeProp, Marker, MediaAsset, MediaFolder, ProjectDoc, Timeline, TimelineItem, TimelineState, TrackFlags, TrackId, TrackKind, TrackUpdate, TransitionItem, TransitionType, Watermark, ZoomEffect } from './types';
import { activeTimeline, DEFAULT_WATERMARK, isAudioTransition, selectedIdsOf, timelineTrackIds, trackEnd, trackKind } from './types';
import { scaleItemKeyframes, splitItemKeyframes, upsertKeyframe } from './keyframes';
import { coerceKeyframeValue, supportsKeyframeProperty } from './keyframeRegistry';
import type { CaptionsData } from '../captions/types';
import type { SerializableFxDef } from '../gl/fx/uniforms';
import type { TranscriptWord, TranscriptVariant } from '../transcript/types';
import { editedFrames, fillerIndices, splitClipTranscript } from '../transcript/edit';

// ── command actions (these map 1:1 to the future agent tools) ─────────────
export type Action =
  | { type: 'add'; item: Omit<TimelineItem, 'startFrame'>; startFrame?: number; ripple?: boolean }
  | { type: 'updateProps'; id: string; patch: Record<string, unknown> }
  | { type: 'move'; id: string; track?: TrackId; startFrame?: number }
  | { type: 'retime'; id: string; startFrame?: number; durationInFrames?: number; srcInFrame?: number; ripple?: boolean }
  | { type: 'setVolume'; id: string; volume: number }
  | { type: 'setFade'; id: string; fadeInFrames?: number; fadeOutFrames?: number }
  | { type: 'setTransform'; id: string; patch: ClipTransform }
  | { type: 'setFilters'; id: string; patch: ClipFilters }
  | { type: 'setZoom'; id: string; patch: Partial<ZoomEffect> | null }
  | { type: 'setEffects'; id: string; effects: ClipEffect[]; defs?: SerializableFxDef[] }
  | { type: 'setSpeed'; id: string; rate: number }
  | { type: 'replaceMedia'; id: string; src: string }
  | { type: 'addMarker'; marker: Marker }
  | { type: 'updateMarker'; id: string; patch: Partial<Marker> }
  | { type: 'removeMarker'; id: string }
  | { type: 'reframeKeyframe'; id: string; frame: number; focalPointX: number; focalPointY: number; magnification: number }
  | { type: 'removeReframeKeyframe'; id: string; frame: number }
  // generic transform keyframes (PRD §4.5 钢笔工具): frame = item-local edit frame
  | { type: 'setKeyframe'; id: string; prop: KeyframeProp; frame: number; value: number; easing?: KeyframeEasing }
  | { type: 'removeKeyframe'; id: string; prop: KeyframeProp; frame: number }
  | { type: 'clearKeyframes'; id: string; prop?: KeyframeProp }
  | { type: 'addTransition'; id: string; incomingItemId: string; transType: TransitionType; durationInFrames?: number; custom?: { frag: string; uniforms: Record<string, number>; label: string } }
  | { type: 'setTransition'; id: string; patch: Partial<TransitionItem> }
  | { type: 'removeTransition'; id: string }
  | { type: 'duplicate'; id: string; newId: string }
  | { type: 'remove'; id: string; ripple?: boolean }
  | { type: 'split'; id: string; atFrame: number; newId: string }
  | { type: 'clear' }
  | { type: 'addAsset'; asset: MediaAsset }
  | { type: 'setCanvas'; width: number; height: number; fit?: AspectFit }
  | { type: 'toggleTrack'; track: TrackId; flag: 'hidden' | 'muted' | 'collapsed' | 'locked' }
  | { type: 'track.create'; track: { id: TrackId; kind: TrackKind; name?: string; role?: TrackFlags['role']; audioRouting?: TrackFlags['audioRouting'] }; order?: number }
  | { type: 'track.update'; track: TrackId; patch: TrackUpdate }
  | { type: 'track.delete'; tracks: TrackId[] }
  | { type: 'track.tighten'; track: TrackId }
  | { type: 'setCaptions'; captions: CaptionsData | null }
  | { type: 'updateCaptions'; patch: Partial<CaptionsData> }
  | { type: 'updateWatermark'; patch: Partial<Watermark> }
  | { type: 'setItemTranscript'; id: string; words: TranscriptWord[] }
  | { type: 'setItemVariants'; id: string; variants: TranscriptVariant[] }
  | { type: 'toggleWord'; id: string; idx: number }
  | { type: 'deleteWords'; id: string; idxs: number[] }
  | { type: 'cleanScript'; id: string; silenceFrames?: number; removeFillers: boolean; gapCapsMs?: Record<string, number>; replaceGapCaps?: boolean }
  /** Per-gap silence cap. afterWordIndex = word after the gap; maxMs=null clears the override. */
  | { type: 'setGapCap'; id: string; afterWordIndex: number; maxMs: number | null }
  /** Speech-block drag: playback order of source word indices (null clears → chronological). */
  | { type: 'setTranscriptPlayOrder'; id: string; playOrder: number[] | null }
  /** Pack items on a track in the given id order (clip drag in 文字稿). */
  | { type: 'reorderTrackItems'; track: string; orderedIds: string[] }
  | { type: 'clearEdits'; id: string }
  | { type: 'fixTranscriptWord'; id: string; wordIndex: number; text: string }
  | { type: 'renameSpeaker'; id: string; from: string; to: string }
  /** AI Voice Isolation attach/clear (isolate_voice → denoisedAudioAssetId). */
  | { type: 'setItemDenoise'; id: string; denoisedSrc: string | null; strength?: number | null }
  | { type: 'select'; id: string | null; mode?: 'replace' | 'toggle' | 'add' }
  | { type: 'selectMany'; ids: string[] }
  | { type: 'selectAll' }
  | { type: 'setFullState'; state: TimelineState };

// ── Project-level actions for multiple timelines ──────────────────────────
// These operate on the ProjectDoc (the set of timelines), not on any single
// timeline's items. All per-timeline Actions above are routed to the active
// timeline by projectReduce.
export type ProjectAction =
  | { type: 'tl.create'; timeline: Timeline; activate?: boolean }
  | { type: 'tl.switch'; id: string }
  | { type: 'tl.duplicate'; id: string; newId: string; name: string; retarget?: { width: number; height: number; fit?: AspectFit }; activate?: boolean }
  | { type: 'tl.delete'; id: string }
  | { type: 'tl.rename'; id: string; name: string }
  | { type: 'tl.retarget'; id: string; width: number; height: number; fit?: AspectFit }
  | { type: 'tl.setHidden'; id: string; hidden: boolean }
  | { type: 'tl.setDoc'; doc: ProjectDoc }
  | { type: 'pool.createFolder'; folder: MediaFolder }
  | { type: 'pool.renameFolder'; id: string; name: string }
  | { type: 'pool.deleteFolder'; id: string }
  | { type: 'pool.moveAssets'; ids: string[]; folderId?: string }
  | { type: 'pool.updateAsset'; id: string; patch: Partial<Pick<MediaAsset, 'name' | 'favorite' | 'code' | 'props' | 'src' | 'durationInFrames' | 'width' | 'height' | 'kind'>> }
  | { type: 'pool.setTranscription'; id: string; patch: Partial<Pick<MediaAsset, 'transcript' | 'transcribeStatus' | 'transcribeError'>> }
  | { type: 'pool.relinkAsset'; id: string; src: string; name?: string; durationInFrames?: number; width?: number; height?: number; kind?: MediaAsset['kind'] }
  | { type: 'pool.removeAsset'; id: string }
  | { type: 'design.set'; style: DesignStyle | null }
  | { type: 'design.patch'; patch: Partial<DesignStyle> };

/** One reducer operation before history grouping. */
export type AtomicAction = Action | ProjectAction;
/** Several reducer operations committed as one undo/redo history entry. */
export interface BatchAction {
  type: 'batch';
  actions: AtomicAction[];
  label?: string;
}
/** any store action: atomic or explicitly grouped (what a draft records) */
export type AnyAction = AtomicAction | BatchAction;
/** dispatch accepted by the command set: store actions + history undo/redo */
export type Dispatch = (a: Action | BatchAction | { type: 'undo' } | { type: 'redo' }) => void;
/** dispatch at the project level: per-timeline + project actions + undo/redo */
export type ProjectDispatch = (a: AnyAction | { type: 'undo' } | { type: 'redo' }) => void;

const MUTATING = new Set(['add', 'updateProps', 'move', 'retime', 'setVolume', 'setFade', 'setTransform', 'setFilters', 'setZoom', 'setEffects', 'setSpeed', 'replaceMedia', 'reframeKeyframe', 'removeReframeKeyframe', 'setKeyframe', 'removeKeyframe', 'clearKeyframes', 'addTransition', 'setTransition', 'removeTransition', 'addMarker', 'updateMarker', 'removeMarker', 'duplicate', 'remove', 'split', 'clear', 'addAsset', 'setCanvas', 'toggleTrack', 'track.create', 'track.update', 'track.delete', 'track.tighten', 'setCaptions', 'updateCaptions', 'updateWatermark', 'setItemTranscript', 'setItemVariants', 'toggleWord', 'deleteWords', 'cleanScript', 'setGapCap', 'setTranscriptPlayOrder', 'reorderTrackItems', 'clearEdits', 'fixTranscriptWord', 'renameSpeaker', 'setItemDenoise', 'setFullState',
  // project-level (tl.switch is navigation → deliberately NOT here, so it makes no history step)
  'tl.create', 'tl.duplicate', 'tl.delete', 'tl.rename', 'tl.retarget', 'tl.setHidden', 'tl.setDoc',
  'pool.createFolder', 'pool.renameFolder', 'pool.deleteFolder', 'pool.moveAssets', 'pool.updateAsset', 'pool.setTranscription', 'pool.relinkAsset', 'pool.removeAsset']);

const EMPTY_CURVE = { version: 1, timebase: 'effect-frame', coordinateSpace: 'composition-normalized', keyframes: [] } as const;

/** True when the item sits on a locked track; modifications must no-op. */
const lockedItem = (s: TimelineState, id: string): boolean =>
  s.items.some((it) => it.id === id && s.tracks?.[it.track]?.locked);

// recompute a transcript-edited clip's duration under its current edit state
function editOptsOf(it: TimelineItem): { maxGapFrames?: number; gapCapsMs?: Record<string, number>; playOrder?: number[] } {
  return { maxGapFrames: it.silenceFrames, gapCapsMs: it.gapCapsMs, playOrder: it.transcriptPlayOrder };
}

function editedDuration(it: TimelineItem, deleted: Set<number>, fps: number): number {
  // 词操作后时长 = 编辑后词流全长 − 已有左裁(仅 audio:词驱动渲染的窗口起点)。
  // 左 trim 在删词/压静音后保留;右 trim 重置为"剩余全部"。video+transcript 走
  // 连续渲染,srcInFrame 是媒体帧语义,不参与词流窗口。
  const trim = it.kind === 'audio' ? (it.srcInFrame ?? 0) : 0;
  return Math.max(1, editedFrames(it.transcript!, deleted, fps, editOptsOf(it)) - trim);
}

export function reduce(s: TimelineState, a: Action): TimelineState {
  switch (a.type) {
    case 'add': {
      if (s.tracks?.[a.item.track]?.locked) return s;
      // compute placement from CURRENT state (correct for sequential adds)
      const startFrame = a.startFrame ?? trackEnd(s, a.item.track);
      const item: TimelineItem = { ...a.item, startFrame };
      // Ripple insert: push same-track clips at/after the
      // insertion point right by the new clip's duration to make room (no overwrite).
      const base = a.ripple
        ? s.items.map((it) => (it.track === item.track && it.startFrame >= startFrame
            ? { ...it, startFrame: it.startFrame + item.durationInFrames } : it))
        : s.items;
      return { ...s, items: [...base, item], selectedId: item.id, selectedIds: [item.id] };
    }
    case 'updateProps':
      if (lockedItem(s, a.id)) return s;
      return {
        ...s,
        items: s.items.map((it) =>
          it.id === a.id ? { ...it, props: { ...it.props, ...a.patch } } : it,
        ),
      };
    case 'move':
      if (s.items.some((it) => it.id === a.id && (s.tracks?.[it.track]?.locked || (a.track && s.tracks?.[a.track]?.locked)))) return s;
      return {
        ...s,
        items: s.items.map((it) =>
          it.id === a.id
            ? { ...it, track: a.track ?? it.track, startFrame: Math.max(0, a.startFrame ?? it.startFrame) }
            : it,
        ),
      };
    case 'retime': {
      if (s.items.some((it) => it.id === a.id && s.tracks?.[it.track]?.locked)) return s;
      const target = s.items.find((it) => it.id === a.id);
      if (!target) return s;
      let srcIn = a.srcInFrame === undefined ? target.srcInFrame : Math.max(0, a.srcInFrame);
      let dur = Math.max(1, a.durationInFrames ?? target.durationInFrames);
      // 转写 audio 的 trim 守卫:窗口 clamp 在编辑后词流总长内(trim 手柄越界自愈,
      // 词↔帧一致 —— 窗口决定播什么,这里保证窗口本身合法)。video 的 srcInFrame
      // 是媒体帧,不 clamp。
      if (target.kind === 'audio' && target.transcript?.length) {
        const total = editedFrames(target.transcript, new Set(target.deletedWordIdx ?? []), s.fps, editOptsOf(target));
        srcIn = Math.min(srcIn ?? 0, Math.max(0, total - 1));
        dur = Math.min(dur, Math.max(1, total - srcIn));
      }
      const startFrame = Math.max(0, a.startFrame ?? target.startFrame);
      const oldEnd = target.startFrame + target.durationInFrames;
      const newEnd = startFrame + dur;
      const deltaEnd = newEnd - oldEnd;
      // ripple retime: when the clip's right edge moves, shift later same-track clips
      // by the same delta (shorten = close gap; lengthen = push).
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id === a.id) {
            return { ...it, startFrame, durationInFrames: dur, srcInFrame: srcIn };
          }
          if (a.ripple && deltaEnd !== 0 && it.track === target.track && it.startFrame >= oldEnd) {
            return { ...it, startFrame: Math.max(0, it.startFrame + deltaEnd) };
          }
          return it;
        }),
      };
    }
    case 'setVolume':
      if (lockedItem(s, a.id)) return s;
      return {
        ...s,
        items: s.items.map((it) => (it.id === a.id ? { ...it, volume: Math.max(0, Math.min(2, a.volume)) } : it)),
      };
    case 'setFade':
      if (lockedItem(s, a.id)) return s;
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== a.id) return it;
          // clamp each fade to at most the clip's length; keep the other side unchanged
          const cap = it.durationInFrames;
          return {
            ...it,
            fadeInFrames: a.fadeInFrames === undefined ? it.fadeInFrames : Math.max(0, Math.min(cap, a.fadeInFrames)),
            fadeOutFrames: a.fadeOutFrames === undefined ? it.fadeOutFrames : Math.max(0, Math.min(cap, a.fadeOutFrames)),
          };
        }),
      };
    case 'setTransform':
      if (lockedItem(s, a.id)) return s;
      return {
        ...s,
        items: s.items.map((it) => (it.id === a.id ? { ...it, transform: { ...it.transform, ...a.patch } } : it)),
      };
    case 'setFilters':
      if (lockedItem(s, a.id)) return s;
      return {
        ...s,
        items: s.items.map((it) => (it.id === a.id ? { ...it, filters: { ...it.filters, ...a.patch } } : it)),
      };
    case 'setZoom':
      if (lockedItem(s, a.id)) return s;
      return {
        ...s,
        items: s.items.map((it) => (it.id === a.id ? { ...it, zoom: a.patch === null ? undefined : { ...it.zoom, ...a.patch } } : it)),
      };
    case 'setEffects': {
      if (lockedItem(s, a.id)) return s;
      // 非内置 fx(插件/submit_shader)的 def 随动作快照进 state.fxDefs——
      // 刷新与无头导出(无内存注册表)才解析得了。不清理:def 小,工程顶多几十条。
      const fxDefs = a.defs?.length
        ? { ...s.fxDefs, ...Object.fromEntries(a.defs.map((d) => [d.id, d])) }
        : s.fxDefs;
      return {
        ...s,
        ...(fxDefs !== s.fxDefs ? { fxDefs } : {}),
        items: s.items.map((it) => (it.id === a.id ? { ...it, effects: a.effects.length ? a.effects : undefined } : it)),
      };
    }
    case 'replaceMedia':
      if (lockedItem(s, a.id)) return s;
      // 转为视频: swap an MG/text clip for the baked video, keeping its slot
      // (track/start/duration/name/volume). Effects/transform/etc. are already
      // rendered into the video, so they're dropped.
      return {
        ...s,
        items: s.items.map((it) => (it.id === a.id
          ? { id: it.id, track: it.track, startFrame: it.startFrame, durationInFrames: it.durationInFrames,
              kind: 'video', name: it.name, src: a.src, volume: it.volume ?? 1 }
          : it)),
      };
    case 'setSpeed': {
      if (lockedItem(s, a.id)) return s;
      const target = s.items.find((it) => it.id === a.id);
      if (!target) return s;
      const rate = Math.max(0.1, Math.min(8, a.rate));
      // preserve the source span: newDuration = sourceSpan / rate
      const sourceSpan = target.durationInFrames * (target.playbackRate ?? 1);
      const durationInFrames = Math.max(1, Math.round(sourceSpan / rate));
      const oldEnd = target.startFrame + target.durationInFrames;
      const deltaEnd = (target.startFrame + durationInFrames) - oldEnd;
      // Right edge moves with speed — ripple later same-track clips to close/open the gap.
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id === a.id) {
            return {
              ...it,
              playbackRate: rate,
              durationInFrames,
              ...(it.keyframes ? { keyframes: scaleItemKeyframes(it.keyframes, durationInFrames / it.durationInFrames) } : {}),
            };
          }
          if (deltaEnd !== 0 && it.track === target.track && it.startFrame >= oldEnd) {
            return { ...it, startFrame: Math.max(0, it.startFrame + deltaEnd) };
          }
          return it;
        }),
      };
    }
    case 'reframeKeyframe':
      if (lockedItem(s, a.id)) return s;
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== a.id) return it;
          const zoom = it.zoom ?? {};
          const curve = zoom.reframeCurve ?? EMPTY_CURVE;
          // replace any keyframe at the same frame, then keep sorted
          const keyframes = [
            ...curve.keyframes.filter((k) => k.frame !== a.frame),
            { frame: a.frame, focalPointX: a.focalPointX, focalPointY: a.focalPointY, magnification: a.magnification },
          ].sort((x, y) => x.frame - y.frame);
          return { ...it, zoom: { ...zoom, reframeCurve: { ...curve, keyframes } } };
        }),
      };
    case 'removeReframeKeyframe':
      if (lockedItem(s, a.id)) return s;
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== a.id || !it.zoom?.reframeCurve) return it;
          const keyframes = it.zoom.reframeCurve.keyframes.filter((k) => k.frame !== a.frame);
          const reframeCurve = keyframes.length ? { ...it.zoom.reframeCurve, keyframes } : undefined;
          return { ...it, zoom: { ...it.zoom, reframeCurve } };
        }),
      };
    case 'setKeyframe': {
      // generic transform keyframe (PRD §4.5): same-frame overwrites, kept sorted.
      const target = s.items.find((x) => x.id === a.id);
      if (!target || !supportsKeyframeProperty(target, a.prop) || lockedItem(s, a.id)
        || !Number.isFinite(a.frame) || !Number.isFinite(a.value)) return s;
      const frame = Math.max(0, Math.round(a.frame));
      const value = coerceKeyframeValue(a.prop, a.value);
      return {
        ...s,
        items: s.items.map((it) => (it.id === a.id
          ? { ...it, keyframes: { ...it.keyframes, [a.prop]: upsertKeyframe(it.keyframes?.[a.prop], frame, value, a.easing) } }
          : it)),
      };
    }
    case 'removeKeyframe': {
      const target = s.items.find((x) => x.id === a.id);
      if (lockedItem(s, a.id) || !target?.keyframes?.[a.prop]?.some((k) => k.frame === a.frame)) return s;
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== a.id) return it;
          const rest = it.keyframes![a.prop]!.filter((k) => k.frame !== a.frame);
          const { [a.prop]: _gone, ...others } = it.keyframes!;
          const keyframes = rest.length ? { ...others, [a.prop]: rest } : others;
          return { ...it, keyframes: Object.keys(keyframes).length ? keyframes : undefined };
        }),
      };
    }
    case 'clearKeyframes': {
      const target = s.items.find((x) => x.id === a.id);
      if (lockedItem(s, a.id) || !target?.keyframes || (a.prop && !target.keyframes[a.prop])) return s;
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== a.id || !it.keyframes) return it;
          if (!a.prop) return { ...it, keyframes: undefined };
          const { [a.prop]: _gone, ...rest } = it.keyframes;
          return { ...it, keyframes: Object.keys(rest).length ? rest : undefined };
        }),
      };
    }
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
    case 'updateMarker':
      return { ...s, markers: (s.markers ?? []).map((m) => (m.id === a.id ? { ...m, ...a.patch } : m)) };
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
      if (!it || s.tracks?.[it.track]?.locked) return s;
      const copy: TimelineItem = { ...it, id: a.newId, props: { ...it.props }, startFrame: trackEnd(s, it.track) };
      return { ...s, items: [...s.items, copy], selectedId: copy.id, selectedIds: [copy.id] };
    }
    case 'clear':
      return { ...s, items: [], selectedId: null, selectedIds: [] };
    case 'setCanvas':
      return { ...s, width: a.width, height: a.height, fit: a.fit ?? s.fit ?? 'contain' };
    case 'toggleTrack': {
      const cur = s.tracks?.[a.track] ?? {};
      return { ...s, tracks: { ...s.tracks, [a.track]: { ...cur, [a.flag]: !cur[a.flag] } } };
    }
    case 'track.create': {
      const ids = timelineTrackIds(s);
      const videos = ids.filter((id) => trackKind(s, id) === 'video');
      const audio = ids.filter((id) => trackKind(s, id) === 'audio');
      const lane = a.track.kind === 'video' ? videos : audio;
      const sourceOrder = Math.max(0, Math.min(a.order ?? lane.length, lane.length));
      const visualIndex = a.track.kind === 'video' ? lane.length - sourceOrder : sourceOrder;
      lane.splice(visualIndex, 0, a.track.id);
      return {
        ...s,
        trackOrder: [...videos, ...audio],
        tracks: { ...s.tracks, [a.track.id]: { kind: a.track.kind, name: a.track.name, role: a.track.role, audioRouting: a.track.audioRouting } },
      };
    }
    case 'track.update': {
      if (!timelineTrackIds(s).includes(a.track)) return s;
      const current = s.tracks?.[a.track] ?? { kind: trackKind(s, a.track) };
      const { order, role, audioRouting, ...rest } = a.patch;
      const next: TrackFlags = { ...current, ...rest };
      if (role === null) delete next.role;
      else if (role !== undefined) next.role = role;
      if (audioRouting) {
        if (audioRouting.duckDepthDb === null) delete next.audioRouting;
        else next.audioRouting = { ...next.audioRouting, ...audioRouting } as TrackFlags['audioRouting'];
      }
      if (next.role !== 'follower') delete next.audioRouting;
      let trackOrder = timelineTrackIds(s);
      if (order !== undefined) {
        const kind = trackKind(s, a.track);
        const videos = trackOrder.filter((id) => id !== a.track && trackKind(s, id) === 'video');
        const audio = trackOrder.filter((id) => id !== a.track && trackKind(s, id) === 'audio');
        const lane = kind === 'video' ? videos : audio;
        const sourceOrder = Math.max(0, Math.min(Math.round(order), lane.length));
        const visualIndex = kind === 'video' ? lane.length - sourceOrder : sourceOrder;
        lane.splice(visualIndex, 0, a.track);
        trackOrder = [...videos, ...audio];
      }
      return { ...s, trackOrder, tracks: { ...s.tracks, [a.track]: next } };
    }
    case 'track.delete': {
      const remove = new Set(a.tracks);
      if (!remove.size || s.items.some((item) => remove.has(item.track)) || (s.transitions ?? []).some((transition) => remove.has(transition.trackId))) return s;
      const ids = timelineTrackIds(s);
      const remaining = ids.filter((id) => !remove.has(id));
      if (!remaining.some((id) => trackKind(s, id) === 'video')) return s;
      const tracks = { ...s.tracks };
      for (const id of remove) delete tracks[id];
      return { ...s, trackOrder: remaining, tracks };
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
      return { ...s, captions: a.captions };
    case 'updateCaptions':
      return s.captions ? { ...s, captions: { ...s.captions, ...a.patch } } : s;
    case 'updateWatermark': {
      // patch-merge over the current watermark (or defaults on first use); clamp
      // opacity at the boundary so a bad LLM value can't escape 0..1.
      const next = { ...(s.watermark ?? DEFAULT_WATERMARK), ...a.patch };
      return { ...s, watermark: { ...next, opacity: Math.max(0, Math.min(1, next.opacity)) } };
    }
    case 'setItemTranscript':
      // Attach words only — keep media duration. Rewriting duration to ASR span
      // collapsed long VO clips when AssemblyAI returned a short word range
      // (looked like "only one incomplete segment"). Duration shrinks only via
      // deleteWords / cleanScript (delete-text = delete-video).
      return {
        ...s,
        items: s.items.map((it) =>
          it.id === a.id
            ? { ...it, transcript: a.words, deletedWordIdx: [], silenceFrames: undefined, gapCapsMs: undefined }
            : it,
        ),
      };
    case 'setItemVariants':
      // Replace the item's text-only transcript variants. Purely additive metadata:
      // it touches neither transcript words, timings, nor durationInFrames.
      return { ...s, items: s.items.map((it) => (it.id === a.id ? { ...it, variants: a.variants } : it)) };
    case 'toggleWord':
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== a.id || !it.transcript) return it;
          const del = new Set(it.deletedWordIdx ?? []);
          if (del.has(a.idx)) del.delete(a.idx);
          else del.add(a.idx);
          return { ...it, deletedWordIdx: [...del], durationInFrames: editedDuration(it, del, s.fps) };
        }),
      };
    case 'deleteWords':
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== a.id || !it.transcript) return it;
          const del = new Set(it.deletedWordIdx ?? []);
          for (const idx of a.idxs) if (idx >= 0 && idx < it.transcript.length) del.add(idx);
          return { ...it, deletedWordIdx: [...del], durationInFrames: editedDuration(it, del, s.fps) };
        }),
      };
    case 'cleanScript':
      return {
        ...s,
        items: s.items.map((it) => {
          if (it.id !== a.id || !it.transcript) return it;
          const del = new Set(it.deletedWordIdx ?? []);
          if (a.removeFillers) for (const idx of fillerIndices(it.transcript)) del.add(idx);
          const next = {
            ...it,
            deletedWordIdx: [...del],
            silenceFrames: a.replaceGapCaps ? undefined : a.silenceFrames,
            gapCapsMs: a.replaceGapCaps ? a.gapCapsMs : it.gapCapsMs,
          };
          return { ...next, durationInFrames: editedDuration(next, del, s.fps) };
        }),
      };
    case 'setGapCap': {
      const it = s.items.find((x) => x.id === a.id);
      if (!it?.transcript || a.afterWordIndex < 0 || a.afterWordIndex >= it.transcript.length) return s;
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
      if (!it?.transcript?.length) return s;
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
      // Pack from the earliest of the reordered set so the block stays in place.
      let t = Math.min(...ordered.map((it) => it.startFrame));
      const starts = new Map<string, number>();
      for (const it of ordered) {
        starts.set(it.id, t);
        t += Math.max(1, it.durationInFrames);
      }
      return {
        ...s,
        items: s.items.map((it) =>
          starts.has(it.id) ? { ...it, startFrame: starts.get(it.id)! } : it,
        ),
      };
    }
    case 'clearEdits':
      return {
        ...s,
        items: s.items.map((it) =>
          it.id === a.id && it.transcript ? { ...it, deletedWordIdx: [], silenceFrames: undefined, gapCapsMs: undefined, transcriptPlayOrder: undefined, durationInFrames: editedFrames(it.transcript, new Set(), s.fps) } : it,
        ),
      };
    case 'fixTranscriptWord': {
      // 改错字:只修正某个转写词的文本，以保持词帧双向一致——只替换 .text,
      // 词的 start/end(帧位)、speaker、词数、以及 clip 的 durationInFrames 全部不动。
      const it = s.items.find((x) => x.id === a.id);
      const word = it?.transcript?.[a.wordIndex];
      // 越界 / 无转写 / 文本未变 → 真正 no-op(返回原 state,不进历史栈)
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
      // 说话人重命名/合并:把 speaker===from 的词全部改标 to，并保持词帧一致——
      // 只改 word.speaker,text/start/end、词数、clip 时长全不动;from→to 同机制覆盖
      // 重命名('A'→'主持人')与合并('B'→'A',两位说话人塌成一位)。
      // 注:TimelineItem 只存 transcript(词),没有 utterances/segment 字段可改。
      const it = s.items.find((x) => x.id === a.id);
      // 无 item / 无转写 / 没有词的 speaker===from → 真正 no-op(返回原 state,不进历史栈)
      if (!it?.transcript?.some((w) => w.speaker === a.from)) return s;
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
    case 'remove': {
      const gone = s.items.find((it) => it.id === a.id);
      if (gone && s.tracks?.[gone.track]?.locked) return s;
      // Ripple delete closes the gap by shifting same-track clips that
      // start at/after the removed clip's OUT point left by its duration.
      const end = gone ? gone.startFrame + gone.durationInFrames : 0;
      const kept = s.items
        .filter((it) => it.id !== a.id)
        .map((it) => (a.ripple && gone && it.track === gone.track && it.startFrame >= end
          ? { ...it, startFrame: Math.max(0, it.startFrame - gone.durationInFrames) } : it));
      const nextSel = selectedIdsOf(s).filter((id) => id !== a.id);
      return {
        ...s,
        items: kept,
        // drop transitions that referenced the removed clip
        transitions: (s.transitions ?? []).filter((t) => t.incomingItemId !== a.id && t.outgoingItemId !== a.id),
        selectedIds: nextSel,
        selectedId: nextSel[nextSel.length - 1] ?? null,
      };
    }
    case 'split': {
      const it = s.items.find((x) => x.id === a.id);
      if (!it || s.tracks?.[it.track]?.locked || a.atFrame <= it.startFrame || a.atFrame >= it.startFrame + it.durationInFrames) return s;
      const cut = a.atFrame - it.startFrame; // frames of source consumed by the left half
      // Partition transcript/deleted/variants/gapCaps per half so each half's words
      // must match its own source window. The cut arrives in VISIBLE-local frames; a trimmed
      // clip's visible frame 0 sits at srcInFrame in the edited stream, so offset before
      // mapping to a word boundary. Fades belong to the outer edges only: the left half's
      // OUT and the right half's IN are now the mid-clip cut, so drop fadeOut-left / fadeIn-right.
      const wordDriven = it.kind === 'audio' && !!it.transcript?.length; // 词驱动渲染路径
      const tp = it.transcript?.length
        ? splitClipTranscript(it, s.fps, cut + (wordDriven ? (it.srcInFrame ?? 0) : 0))
        : null;
      // generic keyframes partition at the same cut (boundary anchors keep每帧采样一致)
      const kp = it.keyframes ? splitItemKeyframes(it.keyframes, cut) : null;
      const left = {
        ...it,
        durationInFrames: cut,
        fadeOutFrames: undefined,
        ...(tp ? { transcript: tp.left.transcript, deletedWordIdx: tp.left.deletedWordIdx, variants: tp.left.variants, gapCapsMs: tp.left.gapCapsMs, transcriptPlayOrder: undefined } : {}),
        ...(kp ? { keyframes: kp[0] } : {}),
      };
      // the right half resumes the source where the left one ended (advances srcInFrame).
      // Transcribed clips: the right half's WORDS are already rebased to start at the
      // boundary, so its window starts at 0 — carrying srcIn+cut would double-trim.
      const right = {
        ...it,
        id: a.newId,
        startFrame: a.atFrame,
        durationInFrames: it.durationInFrames - cut,
        srcInFrame: wordDriven && tp ? 0 : (it.srcInFrame ?? 0) + cut,
        fadeInFrames: undefined,
        ...(tp ? { transcript: tp.right.transcript, deletedWordIdx: tp.right.deletedWordIdx, variants: tp.right.variants, gapCapsMs: tp.right.gapCapsMs, transcriptPlayOrder: undefined } : {}),
        ...(kp ? { keyframes: kp[1] } : {}),
      };
      return { ...s, items: s.items.flatMap((x) => (x.id === a.id ? [left, right] : [x])) };
    }
    case 'select': {
      if (a.id === null) return { ...s, selectedId: null, selectedIds: [] };
      const mode = a.mode ?? 'replace';
      let ids = selectedIdsOf(s);
      if (mode === 'replace') ids = [a.id];
      else if (mode === 'toggle') {
        ids = ids.includes(a.id) ? ids.filter((id) => id !== a.id) : [...ids, a.id];
      } else if (mode === 'add') {
        if (!ids.includes(a.id)) ids = [...ids, a.id];
      }
      // drop ids that no longer exist
      const live = new Set(s.items.map((it) => it.id));
      ids = ids.filter((id) => live.has(id));
      return { ...s, selectedIds: ids, selectedId: ids[ids.length - 1] ?? null };
    }
    case 'selectMany': {
      const live = new Set(s.items.map((it) => it.id));
      const ids = a.ids.filter((id) => live.has(id));
      return { ...s, selectedIds: ids, selectedId: ids[ids.length - 1] ?? null };
    }
    case 'selectAll': {
      const ids = s.items.map((it) => it.id);
      return { ...s, selectedIds: ids, selectedId: ids[ids.length - 1] ?? null };
    }
    case 'setFullState':
      return a.state; // atomic commit of a proposal's result (one history step)
    default:
      return s;
  }
}

// ── project reducer (routes per-timeline actions to the active timeline) ───
export const maxOrder = (p: ProjectDoc) => p.timelines.reduce((m, t) => Math.max(m, t.order), -1);
const isProjectAction = (a: { type: string }): a is ProjectAction => a.type.startsWith('tl.') || a.type.startsWith('pool.') || a.type.startsWith('design.');

// stamp a per-timeline reducer result back onto its identity (setFullState
// returns a bare TimelineState, so id/name/order must be re-applied).
const stamp = (next: TimelineState, id: string, name: string, order: number): Timeline => {
  const { assets: _derivedAssets, ...persisted } = next;
  return { ...persisted, id, name, order };
};

export function projectReduce(p: ProjectDoc, a: AnyAction): ProjectDoc {
  if (a.type === 'batch') {
    return a.actions.reduce((doc, action) => projectReduce(doc, action), p);
  }
  if (a.type === 'addAsset') {
    if (p.assets.some((asset) => asset.id === a.asset.id)) return p;
    return { ...p, assets: [...p.assets, a.asset] };
  }
  if (isProjectAction(a)) {
    switch (a.type) {
      case 'tl.create': {
        const activeTimelineId = a.activate === false ? p.activeTimelineId : a.timeline.id;
        return { ...p, timelines: [...p.timelines, a.timeline], activeTimelineId };
      }
      case 'tl.switch':
        return p.activeTimelineId !== a.id && p.timelines.some((t) => t.id === a.id)
          ? { ...p, activeTimelineId: a.id }
          : p;
      case 'tl.duplicate': {
        const src = p.timelines.find((t) => t.id === a.id);
        if (!src) return p;
        // clone verbatim (item ids stay — timelines never share one items[] array,
        // so ids can't collide; retarget swaps the canvas for long→short).
        const copy: Timeline = {
          ...src, id: a.newId, name: a.name, order: maxOrder(p) + 1, selectedId: null, hidden: false,
          ...(a.retarget ? { width: a.retarget.width, height: a.retarget.height, fit: a.retarget.fit ?? src.fit ?? 'contain' } : {}),
        };
        return { ...p, timelines: [...p.timelines, copy], activeTimelineId: a.activate === false ? p.activeTimelineId : copy.id };
      }
      case 'tl.delete': {
        if (p.timelines.length <= 1) return p; // keep at least one timeline
        const rest = p.timelines.filter((t) => t.id !== a.id);
        const fallback = rest.find((t) => !t.hidden) ?? rest[0];
        const activeTimelineId = p.activeTimelineId === a.id ? fallback.id : p.activeTimelineId;
        return { ...p, timelines: rest, activeTimelineId };
      }
      case 'tl.rename':
        return { ...p, timelines: p.timelines.map((t) => (t.id === a.id ? { ...t, name: a.name } : t)) };
      case 'tl.retarget':
        return { ...p, timelines: p.timelines.map((t) => (t.id === a.id ? { ...t, width: a.width, height: a.height, fit: a.fit ?? t.fit ?? 'contain' } : t)) };
      case 'tl.setHidden': {
        // The last visible timeline cannot be hidden.
        const visible = p.timelines.filter((t) => !t.hidden);
        if (a.hidden && visible.length <= 1 && visible[0]?.id === a.id) return p;
        const timelines = p.timelines.map((t) => (t.id === a.id ? { ...t, hidden: a.hidden } : t));
        // hiding the active timeline: the editor must show something → first visible
        const activeTimelineId =
          a.hidden && p.activeTimelineId === a.id
            ? (timelines.find((t) => !t.hidden)?.id ?? p.activeTimelineId)
            : p.activeTimelineId;
        return { ...p, timelines, activeTimelineId };
      }
      case 'tl.setDoc':
        return a.doc; // atomic commit of a project-level proposal (one history step)
      case 'pool.createFolder':
        return p.mediaFolders.some((folder) => folder.parentId === a.folder.parentId && folder.name === a.folder.name)
          ? p
          : { ...p, mediaFolders: [...p.mediaFolders, a.folder] };
      case 'pool.renameFolder': {
        const folder = p.mediaFolders.find((item) => item.id === a.id);
        if (!folder || folder.name === a.name || p.mediaFolders.some((item) => item.id !== a.id && item.parentId === folder.parentId && item.name === a.name)) return p;
        return { ...p, mediaFolders: p.mediaFolders.map((item) => item.id === a.id ? { ...item, name: a.name } : item) };
      }
      case 'pool.deleteFolder':
        if (!p.mediaFolders.some((folder) => folder.id === a.id)) return p;
        if (p.assets.some((asset) => asset.folderId === a.id) || p.mediaFolders.some((folder) => folder.parentId === a.id)) return p;
        return { ...p, mediaFolders: p.mediaFolders.filter((folder) => folder.id !== a.id) };
      case 'pool.moveAssets': {
        if (a.folderId && !p.mediaFolders.some((folder) => folder.id === a.folderId)) return p;
        const ids = new Set(a.ids);
        if (!p.assets.some((asset) => ids.has(asset.id) && asset.folderId !== a.folderId)) return p;
        return { ...p, assets: p.assets.map((asset) => ids.has(asset.id) ? { ...asset, folderId: a.folderId } : asset) };
      }
      case 'pool.updateAsset': {
        const asset = p.assets.find((item) => item.id === a.id);
        if (!asset || Object.entries(a.patch).every(([key, value]) => asset[key as keyof MediaAsset] === value)) return p;
        return { ...p, assets: p.assets.map((item) => item.id === a.id ? { ...item, ...a.patch } : item) };
      }
      case 'pool.setTranscription': {
        // Ingest ASR result → pool asset. Objects (words[]) always
        // differ by identity, so unlike updateAsset we don't early-out on equality.
        if (!p.assets.some((item) => item.id === a.id)) return p;
        return { ...p, assets: p.assets.map((item) => item.id === a.id ? { ...item, ...a.patch } : item) };
      }
      case 'pool.relinkAsset': {
        // Relink File / Relink Missing Media updates the pool asset and every clip using its old src.
        const asset = p.assets.find((item) => item.id === a.id);
        if (!asset) return p;
        const oldSrc = asset.src;
        const nextAsset: MediaAsset = {
          ...asset,
          src: a.src,
          name: a.name ?? asset.name,
          durationInFrames: a.durationInFrames ?? asset.durationInFrames,
          width: a.width ?? asset.width,
          height: a.height ?? asset.height,
          kind: a.kind ?? asset.kind,
        };
        return {
          ...p,
          assets: p.assets.map((item) => (item.id === a.id ? nextAsset : item)),
          timelines: p.timelines.map((tl) => ({
            ...tl,
            items: tl.items.map((it) => {
              if (it.src !== oldSrc && !(it.kind === 'motion-graphic' && it.templateId === a.id)) return it;
              if (it.kind === 'motion-graphic' && it.templateId === a.id) return it; // MG code assets don't use src relink
              return {
                ...it,
                src: a.src,
                name: a.name ?? it.name,
                width: a.width ?? it.width,
                height: a.height ?? it.height,
                durationInFrames: a.durationInFrames ?? it.durationInFrames,
                kind: (a.kind && a.kind !== 'motion-graphic' ? a.kind : it.kind) as typeof it.kind,
              };
            }),
          })),
        };
      }
      case 'pool.removeAsset':
        if (!p.assets.some((item) => item.id === a.id)) return p;
        return { ...p, assets: p.assets.filter((item) => item.id !== a.id) };
      // Design style represents the project's brand.
      case 'design.set':
        return { ...p, designStyle: a.style ?? undefined };
      case 'design.patch':
        return { ...p, designStyle: { colors: [], fonts: [], ...p.designStyle, ...a.patch } };
      default:
        return p;
    }
  }
  // per-timeline action → apply to the active timeline only
  const active = activeTimeline(p);
  if (!active) return p;
  const next = reduce(active, a);
  if (next === active) return p;
  const stamped = stamp(next, active.id, active.name, active.order);
  return { ...p, timelines: p.timelines.map((t) => (t.id === active.id ? stamped : t)) };
}

// ── history wrapper (snapshot-based undo/redo over the whole project) ──────
export interface History {
  past: ProjectDoc[];
  present: ProjectDoc;
  future: ProjectDoc[];
}

const HISTORY_LIMIT = 100;
const pushHistory = (past: ProjectDoc[], doc: ProjectDoc) => [...past, doc].slice(-HISTORY_LIMIT);

function reduceHistoryAction(present: ProjectDoc, action: AnyAction): {
  next: ProjectDoc;
  mutating: boolean;
} {
  if (action.type !== 'batch') {
    const next = projectReduce(present, action);
    return { next, mutating: next !== present && MUTATING.has(action.type) };
  }
  let next = present;
  let mutating = false;
  for (const entry of action.actions) {
    const reduced = projectReduce(next, entry);
    if (reduced !== next && MUTATING.has(entry.type)) mutating = true;
    next = reduced;
  }
  return { next, mutating };
}

export function historyReduce(h: History, a: AnyAction | { type: 'undo' } | { type: 'redo' }): History {
  if (a.type === 'undo') {
    if (!h.past.length) return h;
    const previous = h.past[h.past.length - 1];
    return { past: h.past.slice(0, -1), present: previous, future: [h.present, ...h.future] };
  }
  if (a.type === 'redo') {
    if (!h.future.length) return h;
    const next = h.future[0];
    return { past: pushHistory(h.past, h.present), present: next, future: h.future.slice(1) };
  }
  const { next, mutating } = reduceHistoryAction(h.present, a);
  if (next === h.present) return h;
  if (mutating) return { past: pushHistory(h.past, h.present), present: next, future: [] };
  return { ...h, present: next }; // select / tl.switch: no history
}
