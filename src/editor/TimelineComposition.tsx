import { useCallback, useEffect, useMemo, useState } from 'react';
import { AbsoluteFill, Sequence, getRemotionEnvironment, useCurrentFrame } from 'remotion';
import { CaptionsLayer } from '../captions/CaptionsLayer';
import { GlTransition } from '../gl/GlTransition';
import { ALL_FX, registerCustomFx } from '../gl/fx/effects';
import { selectTransitionPreviewAdapter, staticEffectPreviewStatus, staticPreviewFallbackStatus } from '../gl/previewAdapter';
import type { SelectedPreviewStatus, SelectedPreviewStatusListener } from '../gl/previewAdapter';
import { captionTrackEntries, CSS_TRANSITION_TYPES, isAudioTransition, isRasterMediaKind, isVisualItemKind, timelineTrackIds, trackKind } from './types';
import { previewTextEditFields } from '../components/preview/previewTextEdit';
import type { AspectFit, CssTransitionType, GlslTransitionType, ProjectDoc, Timeline, TimelineItem, TimelineState, TransitionDirection } from './types';
import { sourceFrameAt } from './sourceLimit';
import { nestedSequenceFrom, resolveTimelineRenderPlan, SequenceGraphError, type SequenceGraphLimits } from './sequenceGraph';
import { continuousVideoAudioGroups } from './transitionAudio';
import { PreviewTransitionIn } from './transitionPreview.tsx';
import { previewTransitionType } from './transitionPreview';
import { TimelineReadinessGate } from './TimelineReadinessGate';
import { timelineReadinessKey } from './timelineReadinessKey';
import { isBackgroundFillActive } from './backgroundFill';
import { ClipWrapper } from './TimelineClipWrapper';
import { GlTransitionVisibility } from './GlTransitionVisibility';
import { updateReadyGlWindows } from './glTransitionVisibilityState';
import { AudioClip, BackgroundFillLayer, ContinuousVideoAudio, MediaFill, VisualClipSurface } from './TimelineMediaLayer';
import { ItemLayer, SolidLayer, TextLayer, WatermarkLayer } from './TimelineGraphicLayers';

const GRID = 'repeating-conic-gradient(#242424 0% 25%, #1c1c1c 0% 50%) 50% / 40px 40px';

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
    const snapshot = {
      kind: status.kind,
      targetId: status.targetId,
      adapter: status.adapter,
      phase: status.phase,
      fallbackReason: status.fallbackReason,
    };
    listener(snapshot);
    return () => listener({ ...snapshot, phase: 'inactive' });
  }, [listener, status.kind, status.targetId, status.adapter, status.phase, status.fallbackReason]);
  return null;
}

function TimelineContent({ state, project, transparent, browserRenderer = false, selectedItemId, onSelectedPreviewStatus, sequenceLimits, forceMuted = false }: TimelineCompositionProps) {
  const [readyGlWindows, setReadyGlWindows] = useState<Set<string>>(() => new Set());
  const setGlWindowReady = useCallback((key: string, ready: boolean) => {
    setReadyGlWindows((current) => updateReadyGlWindows(current, key, ready));
  }, []);
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
  const captionEntries = captionTrackEntries(state);
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
  interface GlWindow { key: string; type: GlslTransitionType | 'custom-shader'; direction: TransitionDirection; from: number; L: number; outgoing: TimelineItem; incoming: TimelineItem; trimOut: number; trimIn: number; customFrag?: string; customUniforms?: Record<string, number>; previewTargetId?: string }
  const glWindows: GlWindow[] = [];
  const staticPreviewStatuses: SelectedPreviewStatus[] = [];
  const selectedEffectItem = environment.isPlayer
    ? state.items.find((item) => item.id === selectedItemId)
    : undefined;
  const selectedEffectStaticStatus = selectedEffectItem
    ? staticEffectPreviewStatus({
        targetId: selectedEffectItem.id,
        effects: selectedEffectItem.effects ?? [],
        registeredEffects: ALL_FX,
        texturable: texturable(selectedEffectItem),
      })
    : null;
  if (selectedEffectStaticStatus) staticPreviewStatuses.push(selectedEffectStaticStatus);
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
      const fallbackType = previewTransitionType(t.type);
      entranceOf.set(t.incomingItemId, {
        type: fallbackType,
        frames: t.durationInFrames,
        dir: t.direction ?? 'left',
        line: t.type === 'clean-line-wipe',
        isolated: false,
      });
      glWindows.push({
        key: t.id,
        type: t.type as GlslTransitionType | 'custom-shader',
        direction: t.direction ?? 'left',
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
    if (selected) {
      const status = staticPreviewFallbackStatus({
        kind: 'transition',
        targetId: t.id,
        adapter: adapter.adapter,
        fallbackReason: adapter.fallbackReason,
      });
      if (status) staticPreviewStatuses.push(status);
    }
  }
  const glVisibilityWindows = glWindows.map((window) => ({
    key: window.key,
    from: window.from,
    durationInFrames: window.L,
    itemIds: [window.outgoing.id, window.incoming.id],
  }));

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
        // Captions off hides on-screen text clips too (render-layer only).
        const captionsOff = state.captionsHidden === true
          || (state.captionsHidden === undefined && captionEntries.length > 0 && captionEntries.every((entry) => !entry.captions?.enabled));
        const hiddenByCaptions = captionsOff && previewTextEditFields(item) !== null;
        const fillBackground = isBackgroundFillActive(state, item);
        const foreground = (
          <ClipWrapper item={item} frameOffset={-eb} hiddenByCaptions={hiddenByCaptions}>
            {(borderRadius) => item.kind === 'sequence'
              ? <VisualClipSurface item={item} fit={fit} canvasW={state.width} canvasH={state.height} borderRadius={borderRadius}>
                  <NestedSequenceLayer item={item} project={project} parentWidth={state.width} parentHeight={state.height} fit={fit} frameOffset={-eb} browserRenderer={browserRenderer} sequenceLimits={sequenceLimits} muted={isMuted(item.track)} />
                </VisualClipSurface>
              : item.kind === 'motion-graphic'
              ? <ItemLayer item={item} canvasW={state.width} canvasH={state.height} fit={fit} borderRadius={borderRadius} />
              : item.kind === 'text'
              ? <TextLayer item={item} canvasW={state.width} canvasH={state.height} fit={fit} />
              : item.kind === 'solid'
              ? <SolidLayer item={item} canvasW={state.width} canvasH={state.height} borderRadius={borderRadius} />
              : <MediaFill item={item} frameOffset={-eb} fit={fillBackground ? 'contain' : fit}
                  muted={isMuted(item.track)} groupedAudio={groupedVideoIds.has(item.id)}
                  gainAt={(frame) => duckGain(item.track, frame)} canvasW={state.width} canvasH={state.height}
                  borderRadius={borderRadius} browserRenderer={browserRenderer}
                  onPreviewStatus={environment.isPlayer && item.id === selectedItemId && !selectedEffectStaticStatus
                    ? onSelectedPreviewStatus : undefined} />}
          </ClipWrapper>
        );
        const content = (
          <>
            {fillBackground && <BackgroundFillLayer item={item} frameOffset={-eb} canvasW={state.width}
              canvasH={state.height} browserRenderer={browserRenderer} />}
            {foreground}
          </>
        );
        return (
          <Sequence key={item.id} from={item.startFrame - eb} durationInFrames={item.durationInFrames + eb + ea} premountFor={premountFrames} name={item.name}>
            <GlTransitionVisibility itemId={item.id} sequenceFrom={item.startFrame - eb}
              windows={glVisibilityWindows} readyWindows={readyGlWindows}>
              {entrance
                ? <PreviewTransitionIn type={entrance.type} frames={entrance.frames} dir={entrance.dir} line={entrance.line} isolated={entrance.isolated}>{content}</PreviewTransitionIn>
                : content}
            </GlTransitionVisibility>
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
            outgoingBackgroundFill={isBackgroundFillActive(state, w.outgoing)}
            incomingBackgroundFill={isBackgroundFillActive(state, w.incoming)}
            customFrag={w.customFrag} customUniforms={w.customUniforms}
            previewTargetId={w.previewTargetId} onPreviewStatus={w.previewTargetId ? onSelectedPreviewStatus : undefined}
            onReadyChange={(ready) => setGlWindowReady(w.key, ready)}
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
      {captionEntries.map(({ id, captions }) => captions?.enabled
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
