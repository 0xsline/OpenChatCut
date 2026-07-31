import { useEffect, useMemo } from 'react';
import { Audio as BrowserAudio, Video as BrowserVideo, type AudioProps as BrowserAudioProps, type VideoProps as BrowserVideoProps } from '@remotion/media';
import { AbsoluteFill, Audio as ServerAudio, Img, OffthreadVideo, Sequence, getRemotionEnvironment, useCurrentFrame } from 'remotion';
import { getCompiledTemplate } from '../template-host';
import { CaptionsLayer } from '../captions/CaptionsLayer';
import { GlTransition } from '../gl/GlTransition';
import { ClipFx } from '../gl/ClipFx';
import { firstGlEffect } from '../gl/clipEffects';
import { ALL_FX, registerCustomFx } from '../gl/fx/effects';
import { selectEffectPreviewAdapter, selectTransitionPreviewAdapter } from '../gl/previewAdapter';
import type { SelectedPreviewStatus, SelectedPreviewStatusListener } from '../gl/previewAdapter';
import { itemEditOpts, itemWindow, keptSegments } from '../transcript/edit';
import { hasOperationalTranscript } from '../transcript/types';
import { voiceIsolationMix } from '../audio/voiceMix';
import { zoomAt } from './zoom';
import { sampleKeyframes, volumeAtFrame } from './keyframes';
import { captionTrackEntries, CSS_TRANSITION_TYPES, isAudioTransition, isRasterMediaKind, isVisualItemKind, timelineTrackIds, trackKind } from './types';
import type { AspectFit, CssTransitionType, GlslTransitionType, KeyframeProp, ProjectDoc, Timeline, TimelineItem, TimelineState, TransitionDirection, TransitionItem, Watermark } from './types';
import { sourceFrameAt } from './sourceLimit';
import { nestedSequenceFrom, resolveTimelineRenderPlan, SequenceGraphError, type SequenceGraphLimits } from './sequenceGraph';
import { continuousVideoAudioGroups } from './transitionAudio';
import { PreviewTransitionIn, previewTransitionType } from './transitionPreview';
import { TimelineReadinessGate, timelineReadinessKey } from './TimelineReadinessGate';

// fade multiplier at a Sequence-relative frame (0..dur): ramps 0→1 across
// fadeIn, then 1→0 across fadeOut. Used for visual opacity + audio volume.
function fadeFactor(frame: number, dur: number, fadeIn = 0, fadeOut = 0): number {
  let f = 1;
  if (fadeIn > 0) f = Math.min(f, frame / fadeIn);
  if (fadeOut > 0) f = Math.min(f, (dur - frame) / fadeOut);
  return Math.max(0, Math.min(1, f));
}

// Wraps a visual clip: ramps opacity for fade in/out and applies its static
// transform (scale / position / rotation). x/y are percent of canvas, so
// translate(x%,y%) offsets by that fraction of the full-frame layer.
// Generic keyframes (PRD §4.5): a keyframed prop overrides its static transform
// value at the current local frame; keyframed opacity multiplies onto the fades.
// Items WITHOUT keyframes take the exact pre-keyframe code path (regression red line).
function ClipWrapper({ item, frameOffset = 0, children }: { item: TimelineItem; frameOffset?: number; children: React.ReactNode }) {
  const frame = useCurrentFrame() + frameOffset;
  const o = fadeFactor(frame, item.durationInFrames, item.fadeInFrames, item.fadeOutFrames);
  const kf = item.keyframes;
  const kv = (prop: KeyframeProp): number | undefined => {
    const list = kf?.[prop];
    return list?.length ? sampleKeyframes(list, frame) : undefined;
  };
  const kx = kv('x');
  const ky = kv('y');
  const kr = kv('rotation');
  const ks = kv('scale');
  const ko = kv('opacity');
  const t = item.transform;
  const transform = (t || kx !== undefined || ky !== undefined || kr !== undefined || ks !== undefined)
    ? `translate(${kx ?? t?.x ?? 0}%, ${ky ?? t?.y ?? 0}%) rotate(${kr ?? t?.rotation ?? 0}deg) scale(${ks ?? t?.scale ?? 1})`
    : undefined;
  // layer crop (split screen/PiP): clip-path cuts the layer first, and then moves it as a whole with transform. When there is no crop
  // This style is not produced at all (return to the red line: the old project DOM remains unchanged).
  const c = t?.crop;
  const cropPct = (v: number | undefined) => `${((v ?? 0) * 100).toFixed(3)}%`;
  const clipPath = c && ((c.left ?? 0) > 0 || (c.top ?? 0) > 0 || (c.right ?? 0) > 0 || (c.bottom ?? 0) > 0)
    ? `inset(${cropPct(c.top)} ${cropPct(c.right)} ${cropPct(c.bottom)} ${cropPct(c.left)})`
    : undefined;
  const opacity = ko === undefined ? o : o * Math.max(0, Math.min(1, ko));
  const fl = item.filters;
  const filter = fl
    ? `brightness(${fl.brightness ?? 1}) contrast(${fl.contrast ?? 1}) saturate(${fl.saturate ?? 1}) blur(${fl.blur ?? 0}px)`
    : undefined;
  // animated zoom (builtin:zoom): scale content toward its focal point over time.
  let inner = children;
  if (item.zoom) {
    const z = zoomAt(item.zoom, frame, item.durationInFrames);
    inner = (
      <AbsoluteFill style={{ transform: `scale(${z.magnification})`, transformOrigin: `${z.focalX * 100}% ${z.focalY * 100}%` }}>
        {children}
      </AbsoluteFill>
    );
  }
  return <AbsoluteFill style={{ opacity, transform, filter, clipPath }}>{inner}</AbsoluteFill>;
}

// One audio clip. With a transcript attached it renders the KEPT segments
// (deleted words' source ranges are skipped, remaining ranges play back-to-back);
// otherwise it plays the whole source.
/** Voice isolation preserves the master source and mixes it with the immutable wet artifact. */

/**
 * Audio cross-fade: at the seam, outgoing ramps 1→0
 * over the last L frames of its clip; incoming ramps 0→1 over the first L frames.
 */
function audioCrossfadeMul(
  item: TimelineItem,
  localFrame: number,
  transitions: TransitionItem[] | undefined,
): number {
  if (!transitions?.length) return 1;
  let m = 1;
  for (const t of transitions) {
    if (t.enabled === false || !isAudioTransition(t.type)) continue;
    const L = Math.max(1, t.durationInFrames);
    if (t.outgoingItemId === item.id) {
      // last L frames of outgoing: 1 → 0
      const from = item.durationInFrames - L;
      if (localFrame >= from) {
        const p = Math.min(1, Math.max(0, (localFrame - from) / L));
        m *= 1 - p;
      }
    }
    if (t.incomingItemId === item.id) {
      // first L frames of incoming: 0 → 1
      if (localFrame < L) {
        const p = Math.min(1, Math.max(0, localFrame / L));
        m *= p;
      }
    }
  }
  return m;
}

function RuntimeAudio({ browserRenderer, ...props }: BrowserAudioProps & { browserRenderer: boolean }) {
  return browserRenderer
    ? <BrowserAudio {...props} />
    : <ServerAudio {...props} preservePitch />;
}

function MixedRuntimeAudio({
  item,
  browserRenderer,
  volume,
  ...props
}: Omit<BrowserAudioProps, 'src'> & {
  item: TimelineItem;
  browserRenderer: boolean;
}) {
  if (!item.denoisedSrc) {
    return <RuntimeAudio browserRenderer={browserRenderer} {...props} src={item.src!} volume={volume} />;
  }
  const mix = voiceIsolationMix(item.denoiseStrength);
  const scaledVolume = (gain: number): BrowserAudioProps['volume'] => (
    typeof volume === 'function'
      ? (frame) => volume(frame) * gain
      : (volume ?? 1) * gain
  );
  return (
    <>
      {mix.dry > 0 && (
        <RuntimeAudio browserRenderer={browserRenderer} {...props} src={item.src!} volume={scaledVolume(mix.dry)} />
      )}
      {mix.wet > 0 && (
        <RuntimeAudio browserRenderer={browserRenderer} {...props} src={item.denoisedSrc} volume={scaledVolume(mix.wet)} />
      )}
    </>
  );
}

type RuntimeVideoProps = Pick<BrowserVideoProps, 'src' | 'trimBefore' | 'trimAfter' | 'playbackRate' | 'volume' | 'style' | 'muted'> & {
  browserRenderer: boolean;
};

function RuntimeVideo({ browserRenderer, ...props }: RuntimeVideoProps) {
  return browserRenderer
    ? <BrowserVideo {...props} />
    : <OffthreadVideo {...props} preservePitch />;
}

function AudioClip({ item, fps, muted, gainAt, transitions, premountFor, browserRenderer }: {
  item: TimelineItem; fps: number; muted: boolean;
  gainAt: (frame: number) => number;
  transitions?: TransitionItem[];
  premountFor: number;
  browserRenderer: boolean;
}) {
  // volume keyframes override the static item.volume (item-local edited frames)
  const volAt = (localFrame: number) => (muted ? 0 : volumeAtFrame(item, localFrame));
  if (!item.src) return null;
  if (hasOperationalTranscript(item)) {
    const del = new Set(item.deletedWordIdx ?? []);
    return (
      <>
        {keptSegments(item.transcript, del, fps, item.startFrame, {
          ...itemEditOpts(item),
          window: itemWindow(item), // trim handle's [srcIn, srcIn+dur) slice (word ↔ frame consistent)
        }).map((seg, k) => (
          <Sequence key={`${item.id}_${k}`} from={seg.fromFrame} durationInFrames={seg.durFrames} premountFor={premountFor} name={item.name}>
            <MixedRuntimeAudio item={item} browserRenderer={browserRenderer} trimBefore={seg.srcStartFrame} trimAfter={seg.srcEndFrame}
              volume={(f) => volAt(seg.fromFrame - item.startFrame + f) * gainAt(seg.fromFrame + f) * audioCrossfadeMul(item, seg.fromFrame - item.startFrame + f, transitions)} />
          </Sequence>
        ))}
      </>
    );
  }
  return (
    <Sequence from={item.startFrame} durationInFrames={item.durationInFrames} premountFor={premountFor} name={item.name}>
      <MixedRuntimeAudio item={item} browserRenderer={browserRenderer} trimBefore={item.srcInFrame ?? 0} playbackRate={item.playbackRate ?? 1}
        volume={(f) => volAt(f)
          * gainAt(item.startFrame + f)
          * fadeFactor(f, item.durationInFrames, item.fadeInFrames, item.fadeOutFrames)
          * audioCrossfadeMul(item, f, transitions)} />
    </Sequence>
  );
}

function ContinuousVideoAudio({ items, muted, gainAt, premountFor, browserRenderer }: {
  items: TimelineItem[];
  muted: boolean;
  gainAt: (frame: number) => number;
  premountFor: number;
  browserRenderer: boolean;
}) {
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) return null;
  const duration = last.startFrame + last.durationInFrames - first.startFrame;
  const volume = (frame: number) => {
    const timelineFrame = first.startFrame + frame;
    const item = items.find((candidate) => timelineFrame >= candidate.startFrame
      && timelineFrame < candidate.startFrame + candidate.durationInFrames);
    if (!item || muted) return 0;
    const localFrame = timelineFrame - item.startFrame;
    return volumeAtFrame(item, localFrame)
      * gainAt(timelineFrame)
      * fadeFactor(localFrame, item.durationInFrames, item.fadeInFrames, item.fadeOutFrames);
  };
  return (
    <Sequence from={first.startFrame} durationInFrames={duration} premountFor={premountFor} name={`${first.name}:audio`}>
      <MixedRuntimeAudio item={first} browserRenderer={browserRenderer} trimBefore={first.srcInFrame ?? 0}
        playbackRate={first.playbackRate ?? 1} volume={volume} />
    </Sequence>
  );
}

// Imported image / video / gif / svg fills the canvas by the fit mode (objectFit).
function MediaFill({ item, frameOffset, fit, muted, groupedAudio, canvasW, canvasH, gainAt, browserRenderer, onPreviewStatus }: { item: TimelineItem; frameOffset: number; fit: AspectFit; muted: boolean; groupedAudio: boolean; canvasW: number; canvasH: number; gainAt: (frame: number) => number; browserRenderer: boolean; onPreviewStatus?: SelectedPreviewStatusListener }) {
  const objectFit = fit === 'cover' ? 'cover' : 'contain';
  const style: React.CSSProperties = { width: '100%', height: '100%', objectFit };
  const still = item.kind === 'image' || item.kind === 'gif' || item.kind === 'svg';
  const trimBefore = sourceFrameAt(item, frameOffset);
  const volume = (frame: number) => {
    const localFrame = frame + frameOffset;
    if (localFrame < 0 || localFrame >= item.durationInFrames) return 0;
    return (muted ? 0 : volumeAtFrame(item, localFrame))
      * gainAt(item.startFrame + localFrame)
      * fadeFactor(localFrame, item.durationInFrames, item.fadeInFrames, item.fadeOutFrames);
  };
  const effectAdapter = selectEffectPreviewAdapter({
    declared: !!firstGlEffect(item),
    texturable: item.kind === 'video' || item.kind === 'image',
  });
  // clip carries a WebGL effect → render pixels through the GL pass; video keeps
  // its audio via a separate muted-visual <Audio> (the GL source video is muted).
  if (effectAdapter.adapter === 'gl-effect') {
    return (
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
        <ClipFx item={item} fit={fit} width={canvasW} height={canvasH} frameOffset={frameOffset} onPreviewStatus={onPreviewStatus} />
        {item.kind !== 'image' && !groupedAudio && (
          <MixedRuntimeAudio item={item} browserRenderer={browserRenderer} trimBefore={trimBefore}
            playbackRate={item.playbackRate ?? 1} volume={volume} />
        )}
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
      {still
        ? <Img src={item.src!} style={style} />
        : item.denoisedSrc
          // visual from original video (muted) + isolated voice track
          ? (
            <>
              <RuntimeVideo browserRenderer={browserRenderer} src={item.src!} trimBefore={trimBefore} playbackRate={item.playbackRate ?? 1} volume={0} muted style={style} />
              {!groupedAudio && (
                <MixedRuntimeAudio item={item} browserRenderer={browserRenderer} trimBefore={trimBefore}
                  playbackRate={item.playbackRate ?? 1} volume={volume} />
              )}
            </>
          )
          : <RuntimeVideo browserRenderer={browserRenderer} src={item.src!} trimBefore={trimBefore} playbackRate={item.playbackRate ?? 1}
              volume={groupedAudio ? 0 : volume} muted={groupedAudio || muted} style={style} />}
    </AbsoluteFill>
  );
}

/** Solid-color fill item. */
function SolidLayer({ item }: { item: TimelineItem }) {
  const color = String(item.props?.color ?? '#1a1a1a');
  return <AbsoluteFill style={{ background: color }} />;
}

const GRID = 'repeating-conic-gradient(#242424 0% 25%, #1c1c1c 0% 50%) 50% / 40px 40px';

// Text watermark overlay: a single label pinned to one
// corner, opacity 0..1. Sizes off canvas height so it scales with any ratio.
function WatermarkLayer({ watermark, canvasH }: { watermark: Watermark; canvasH: number }) {
  const style: React.CSSProperties = {
    position: 'absolute',
    color: '#ffffff',
    opacity: Math.max(0, Math.min(1, watermark.opacity)),
    fontSize: Math.round(canvasH * 0.035),
    fontWeight: 700,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    textShadow: '0 2px 8px rgba(0,0,0,0.6)',
    whiteSpace: 'nowrap',
  };
  const pad = Math.round(canvasH * 0.04);
  if (watermark.position[0] === 't') style.top = pad; else style.bottom = pad;
  if (watermark.position[1] === 'l') style.left = pad; else style.right = pad;
  return <AbsoluteFill style={{ pointerEvents: 'none' }}><div style={style}>{watermark.text}</div></AbsoluteFill>;
}

// Render a text clip in the 1920×1080 design box (so fontSize is resolution-
// independent), scaled+aligned to the canvas. Props: text/fontSize/color/
// fontWeight/align. Position/rotation come from the clip transform.
function TextLayer({ item, canvasW, canvasH, fit }: { item: TimelineItem; canvasW: number; canvasH: number; fit: AspectFit }) {
  const dw = item.width ?? 1920;
  const dh = item.height ?? 1080;
  const scale = fit === 'cover' ? Math.max(canvasW / dw, canvasH / dh) : Math.min(canvasW / dw, canvasH / dh);
  const p = item.props ?? {};
  const text = String(p.text ?? '文字');
  const fontSize = Number(p.fontSize ?? 96);
  const color = String(p.color ?? '#ffffff');
  const fontWeight = Number(p.fontWeight ?? 700);
  const align = (p.align === 'left' || p.align === 'right' ? p.align : 'center') as 'left' | 'center' | 'right';
  const justify = align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center';
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', overflow: 'hidden' }}>
      <div style={{ width: dw, height: dh, flexShrink: 0, transform: `scale(${scale})`, display: 'flex', alignItems: 'center', justifyContent: justify, padding: '0 96px', boxSizing: 'border-box' }}>
        <div style={{ color, fontSize, fontWeight, textAlign: align, width: '100%', fontFamily: 'system-ui, -apple-system, sans-serif', textShadow: '0 3px 16px rgba(0,0,0,0.55)', whiteSpace: 'pre-wrap', lineHeight: 1.2 }}>{text}</div>
      </div>
    </AbsoluteFill>
  );
}

// Render one MG in its DESIGN box (width×height), then scale+center it to the
// canvas according to the timeline `fit` mode: contain letterboxes,
// cover fills+crops. At 16:9 with 1920×1080 designs the scale is 1 (no change).
function ItemLayer({ item, canvasW, canvasH, fit }: { item: TimelineItem; canvasW: number; canvasH: number; fit: AspectFit }) {
  const dw = item.width ?? 1920;
  const dh = item.height ?? 1080;
  const scale = fit === 'cover' ? Math.max(canvasW / dw, canvasH / dh) : Math.min(canvasW / dw, canvasH / dh);
  try {
    const Template = getCompiledTemplate(item.code ?? '');
    return (
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', overflow: 'hidden' }}>
        <div style={{ width: dw, height: dh, position: 'relative', flexShrink: 0, transform: `scale(${scale})` }}>
          <Template item={{ props: item.props ?? {}, width: dw, height: dh }} />
        </div>
      </AbsoluteFill>
    );
  } catch (e) {
    return (
      <AbsoluteFill style={{ color: '#f88', fontFamily: 'monospace', fontSize: 20, padding: 40, whiteSpace: 'pre-wrap' }}>
        {(item.name + ' — compile error:\n') + (e instanceof Error ? e.message : String(e))}
      </AbsoluteFill>
    );
  }
}
function NestedSequenceLayer({ item, project, parentWidth, parentHeight, fit, frameOffset, browserRenderer, sequenceLimits, muted }: {
  item: TimelineItem;
  project?: ProjectDoc;
  parentWidth: number;
  parentHeight: number;
  fit: AspectFit;
  frameOffset: number;
  browserRenderer: boolean;
  sequenceLimits?: SequenceGraphLimits;
  muted: boolean;
}) {
  const parentFrame = useCurrentFrame();
  const localFrame = parentFrame + frameOffset;
  const resolved = useMemo(() => {
    if (!project || !item.timelineId) return null;
    const child = project.timelines.find((timeline) => timeline.id === item.timelineId);
    return child ? {
      child,
      durationInFrames: resolveTimelineRenderPlan(project, child.id, sequenceLimits).durationInFrames,
    } : null;
  }, [item.timelineId, project, sequenceLimits]);
  if (!resolved) {
    throw new SequenceGraphError({
      code: 'SEQUENCE_TIMELINE_MISSING',
      itemId: item.id,
      referencedTimelineId: item.timelineId,
      path: [item.timelineId ?? ''],
    });
  }
  const { child, durationInFrames: childDuration } = resolved;
  const sourceFrame = Math.min(childDuration - 1, sourceFrameAt(item, localFrame));
  const dynamicFrom = nestedSequenceFrom(parentFrame, sourceFrame);
  const scale = fit === 'cover'
    ? Math.max(parentWidth / child.width, parentHeight / child.height)
    : Math.min(parentWidth / child.width, parentHeight / child.height);
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', overflow: 'hidden' }}>
      <div style={{ width: child.width, height: child.height, position: 'relative', flexShrink: 0, transform: `scale(${scale})` }}>
        <Sequence from={dynamicFrom} durationInFrames={childDuration} layout="none">
          <TimelineContent
            state={child}
            project={project}
            timelineId={child.id}
            transparent
            browserRenderer={browserRenderer}
            sequenceLimits={sequenceLimits}
            forceMuted={muted}
          />
        </Sequence>
      </div>
    </AbsoluteFill>
  );
}


// Renders the ENTIRE timeline. Visual tracks composite bottom-up: V1 then V2 on
// top. Audio items (A1/A2) play via <Audio> and produce no picture.
export type TimelineCompositionProps = Record<string, unknown> & {
  state: TimelineState;
  project?: ProjectDoc;
  timelineId?: string;
  sequenceLimits?: SequenceGraphLimits;
  /** Mute all descendant audio when a containing sequence track is muted. */
  forceMuted?: boolean;
  transparent?: boolean;
  /** Use @remotion/media so @remotion/web-renderer can decode media via WebCodecs. */
  browserRenderer?: boolean;
  /** The selected clip is the Player's explicit full-fidelity GL preview target. */
  selectedItemId?: string | null;
  onSelectedPreviewStatus?: SelectedPreviewStatusListener;
};

function SelectedPreviewStatusReporter({ status, listener }: {
  status: SelectedPreviewStatus;
  listener?: SelectedPreviewStatusListener;
}) {
  useEffect(() => {
    if (!listener) return undefined;
    listener(status);
    return () => listener({ ...status, phase: 'inactive' });
  }, [listener, status.kind, status.targetId, status.adapter, status.phase, status.fallbackReason]);
  return null;
}

function TimelineContent({ state, project, transparent, browserRenderer = false, selectedItemId, onSelectedPreviewStatus, sequenceLimits, forceMuted = false }: TimelineCompositionProps) {
  // Non-built-in fx (plugin/submit_shader)def is self-contained with state: synchronously registered into ALL_FX before rendering,
  // The first frame of the subcomponent (MediaFill's firstGlEffect route) is parsed - a fresh browser with headless export
  // There is no memory registry, it all depends on this. Idempotism is guarded; rendering external registries is the only deliberate exception here.
  if (state.fxDefs) {
    for (const def of Object.values(state.fxDefs)) if (!(def.id in ALL_FX)) registerCustomFx(def);
  }
  const isHidden = (t: TimelineItem['track']) => state.tracks?.[t]?.hidden ?? false;
  const isMuted = (t: TimelineItem['track']) => forceMuted || (state.tracks?.[t]?.muted ?? false);
  const trackIds = timelineTrackIds(state);
  const visualTracks = trackIds.filter((id) => trackKind(state, id) === 'video');
  // hidden track = fully disabled (no picture, no sound)
  const visual = state.items.filter((it) => isVisualItemKind(it.kind) && visualTracks.includes(it.track) && !isHidden(it.track));
  // Paint visual bottom-to-top. Timeline rows are stored top-to-bottom.
  const ordered = [...visual].sort((a, b) => a.track === b.track
    ? a.startFrame - b.startFrame
    : visualTracks.indexOf(b.track) - visualTracks.indexOf(a.track));
  const audio = state.items.filter((it) => it.kind === 'audio' && it.src && !isHidden(it.track));
  const anchorRanges = state.items.filter((item) => state.tracks?.[item.track]?.role === 'anchor'
    && !isHidden(item.track) && !isMuted(item.track) && !!item.src)
    .map((item) => [item.startFrame, item.startFrame + item.durationInFrames] as const);
  const duckGain = (track: TimelineItem['track'], frame: number): number => {
    const config = state.tracks?.[track];
    if (config?.role !== 'follower' || !anchorRanges.some(([from, to]) => frame >= from && frame < to)) return 1;
    return 10 ** ((config.audioRouting?.duckDepthDb ?? -12) / 20);
  };
  const fit: AspectFit = state.fit ?? 'contain';
  // Preview mounts each clip 2s in advance (freezes first frame + transparency): video elements seek/decode in advance, GL compiles in advance,
  // Eliminate the "last frame stuck" caused by cold start of three media elements at the starting point of the cut point/transition window in the same frame.
  // Headless export renders deterministically frame by frame, preheating will only slow down the export, set to 0.
  const environment = getRemotionEnvironment();
  const premountFrames = environment.isRendering ? 0 : Math.round(state.fps * 2);
  const videoAudioGroups = continuousVideoAudioGroups(ordered, state.transitions);
  const groupedVideoIds = new Set(videoAudioGroups.flatMap((group) => group.map((item) => item.id)));

  // In the Player, only the transition into the selected clip pays the dual
  // decoder + WebGL cost. It uses the same GlTransition component as export.
  // Other transitions keep the existing CSS approximation. Non-texturable
  // sources and missing custom shaders are explicit fallback states.
  const byId = new Map(state.items.map((it) => [it.id, it]));
  const texturable = (it?: TimelineItem) => !!it && isRasterMediaKind(it.kind) && it.kind !== 'svg' && it.kind !== 'gif';
  const enabledTransitions = (state.transitions ?? []).filter((t) => t.enabled !== false);
  const visualTransitions = enabledTransitions.filter((t) => !isAudioTransition(t.type));
  type PreviewEdge = { type: CssTransitionType; frames: number; dir: TransitionDirection; line?: boolean; isolated: boolean };
  const entranceOf = new Map<string, PreviewEdge>();
  const extendBefore = new Map<string, number>();
  const extendAfter = new Map<string, number>();
  interface GlWindow { key: string; type: GlslTransitionType | 'custom-shader'; direction: TransitionDirection; fallbackType: CssTransitionType; fallbackLine?: boolean; from: number; L: number; outgoing: TimelineItem; incoming: TimelineItem; trimOut: number; trimIn: number; customFrag?: string; customUniforms?: Record<string, number>; previewTargetId?: string }
  const glWindows: GlWindow[] = [];
  const staticPreviewStatuses: SelectedPreviewStatus[] = [];
  const selectedEffectItem = environment.isPlayer
    ? state.items.find((item) => item.id === selectedItemId)
    : undefined;
  const selectedEffect = selectedEffectItem ? firstGlEffect(selectedEffectItem) : null;
  if (selectedEffectItem && selectedEffect) {
    const adapter = selectEffectPreviewAdapter({
      declared: true,
      texturable: selectedEffectItem.kind === 'video' || selectedEffectItem.kind === 'image',
    });
    staticPreviewStatuses.push({
      kind: 'effect',
      targetId: selectedEffectItem.id,
      adapter: adapter.adapter,
      phase: 'fallback',
      fallbackReason: adapter.fallbackReason ?? 'media-loading',
    });
  }
  for (const t of visualTransitions) {
    const half = Math.floor(t.durationInFrames / 2);
    const out = byId.get(t.outgoingItemId);
    const inc = byId.get(t.incomingItemId);
    extendBefore.set(t.incomingItemId, half);
    extendAfter.set(t.outgoingItemId, t.durationInFrames - half);
    const selected = environment.isPlayer && t.incomingItemId === selectedItemId;
    const adapter = selectTransitionPreviewAdapter({
      mode: environment.isPlayer ? 'player' : 'render',
      selected,
      type: t.type,
      texturable: texturable(out) && texturable(inc),
      hasShader: t.type !== 'custom-shader' || !!t.customFrag,
    });
    if (adapter.adapter === 'gl-transition') {
      const from = inc!.startFrame - half; // R = incoming.from - floor(L/2)
      glWindows.push({
        key: t.id,
        type: t.type as GlslTransitionType | 'custom-shader',
        direction: t.direction ?? 'left',
        fallbackType: previewTransitionType(t.type),
        fallbackLine: t.type === 'clean-line-wipe',
        from,
        L: t.durationInFrames,
        outgoing: out!,
        incoming: inc!,
        trimOut: sourceFrameAt(out!, from - out!.startFrame),
        trimIn: sourceFrameAt(inc!, from - inc!.startFrame),
        previewTargetId: selected ? t.id : undefined,
        // custom-shader carries its GLSL + uniforms from the item to GlTransition
        ...(t.type === 'custom-shader' ? { customFrag: t.customFrag, customUniforms: t.customUniforms } : {}),
      });
      if (selected) {
        staticPreviewStatuses.push({
          kind: 'transition',
          targetId: t.id,
          adapter: 'css-transition',
          phase: 'fallback',
          fallbackReason: 'media-loading',
        });
      }
      continue;
    }
    const cssType = environment.isPlayer
      ? previewTransitionType(t.type)
      : CSS_TRANSITION_TYPES.has(t.type) ? t.type as CssTransitionType : 'cross-dissolve';
    entranceOf.set(t.incomingItemId, {
      type: cssType,
      frames: t.durationInFrames,
      dir: t.direction ?? 'left',
      line: t.type === 'clean-line-wipe',
      isolated: false,
    });
    if (selected && adapter.fallbackReason) {
      staticPreviewStatuses.push({
        kind: 'transition',
        targetId: t.id,
        adapter: 'css-transition',
        phase: 'fallback',
        fallbackReason: adapter.fallbackReason,
      });
    }
  }

  return (
    <AbsoluteFill style={{ background: transparent ? undefined : GRID }}>
      {staticPreviewStatuses.map((status) => (
        <SelectedPreviewStatusReporter
          key={`${status.kind}:${status.targetId}`}
          status={status}
          listener={onSelectedPreviewStatus}
        />
      ))}
      {ordered.map((item) => {
        const eb = extendBefore.get(item.id) ?? 0;
        const ea = extendAfter.get(item.id) ?? 0;
        const entrance = entranceOf.get(item.id);
        const content = (
          <ClipWrapper item={item} frameOffset={-eb}>
            {item.kind === 'sequence'
              ? <NestedSequenceLayer item={item} project={project} parentWidth={state.width} parentHeight={state.height} fit={fit} frameOffset={-eb} browserRenderer={browserRenderer} sequenceLimits={sequenceLimits} muted={isMuted(item.track)} />
              : item.kind === 'motion-graphic'
              ? <ItemLayer item={item} canvasW={state.width} canvasH={state.height} fit={fit} />
              : item.kind === 'text'
              ? <TextLayer item={item} canvasW={state.width} canvasH={state.height} fit={fit} />
              : item.kind === 'solid'
              ? <SolidLayer item={item} />
              : <MediaFill item={item} frameOffset={-eb} fit={fit} muted={isMuted(item.track)} groupedAudio={groupedVideoIds.has(item.id)} gainAt={(frame) => duckGain(item.track, frame)} canvasW={state.width} canvasH={state.height} browserRenderer={browserRenderer} onPreviewStatus={environment.isPlayer && item.id === selectedItemId ? onSelectedPreviewStatus : undefined} />}
          </ClipWrapper>
        );
        return (
          <Sequence key={item.id} from={item.startFrame - eb} durationInFrames={item.durationInFrames + eb + ea} premountFor={premountFrames} name={item.name}>
            {entrance
              ? <PreviewTransitionIn type={entrance.type} frames={entrance.frames} dir={entrance.dir} line={entrance.line} isolated={entrance.isolated}>{content}</PreviewTransitionIn>
              : content}
          </Sequence>
        );
      })}
      {/* GLSL transition windows: painted over both clips, beneath captions */}
      {glWindows.map((w) => (
        <Sequence key={w.key} from={w.from} durationInFrames={w.L} premountFor={premountFrames} name={`tr:${w.type}`}>
          <GlTransition
            type={w.type} direction={w.direction} L={w.L} windowStart={w.from}
            outgoing={w.outgoing} incoming={w.incoming} trimOut={w.trimOut} trimIn={w.trimIn}
            width={state.width} height={state.height} fit={fit}
            fallbackType={w.fallbackType} fallbackLine={w.fallbackLine}
            customFrag={w.customFrag} customUniforms={w.customUniforms}
            previewTargetId={w.previewTargetId} onPreviewStatus={w.previewTargetId ? onSelectedPreviewStatus : undefined}
          />
        </Sequence>
      ))}
      {audio.map((item) => (
        <AudioClip
          key={item.id}
          item={item}
          fps={state.fps}
          muted={isMuted(item.track)}
          gainAt={(frame) => duckGain(item.track, frame)}
          transitions={state.transitions}
          premountFor={premountFrames}
          browserRenderer={browserRenderer}
        />
      ))}
      {videoAudioGroups.map((group) => (
        <ContinuousVideoAudio
          key={`audio:${group[0]!.id}`}
          items={group}
          muted={isMuted(group[0]!.track)}
          gainAt={(frame) => duckGain(group[0]!.track, frame)}
          premountFor={premountFrames}
          browserRenderer={browserRenderer}
        />
      ))}
      {captionTrackEntries(state).map(({ id, captions }) => captions?.enabled
        ? <CaptionsLayer key={id} captions={captions} items={state.items} />
        : null)}
      {state.watermark?.enabled && state.watermark.text
        && <WatermarkLayer watermark={state.watermark} canvasH={state.height} />}
    </AbsoluteFill>
  );
}

export function TimelineComposition(props: TimelineCompositionProps) {
  const stateTimelineId = 'id' in props.state && typeof props.state.id === 'string' ? props.state.id : undefined;
  const timelineId = props.timelineId ?? stateTimelineId ?? props.project?.activeTimelineId;
  if (props.state.items.some((item) => item.kind === 'sequence') && (!props.project || !timelineId)) {
    const item = props.state.items.find((candidate) => candidate.kind === 'sequence')!;
    throw new SequenceGraphError({
      code: 'SEQUENCE_TIMELINE_MISSING',
      itemId: item.id,
      referencedTimelineId: item.timelineId,
      path: [item.timelineId ?? ''],
    });
  }
  const plan = props.project && timelineId
    ? resolveTimelineRenderPlan(props.project, timelineId, props.sequenceLimits)
    : null;
  const dependencies = plan
    ? plan.timelineIds
        .filter((id) => id !== timelineId)
        .map((id) => props.project!.timelines.find((timeline) => timeline.id === id))
        .filter((timeline): timeline is Timeline => !!timeline)
    : [];
  return (
    <TimelineReadinessGate key={timelineReadinessKey(props.state, dependencies)} state={props.state} dependencies={dependencies}>
      {() => <TimelineContent {...props} timelineId={timelineId} />}
    </TimelineReadinessGate>
  );
}
