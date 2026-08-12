import type { CSSProperties } from 'react';
import {
  Audio as BrowserAudio,
  Video as BrowserVideo,
  type AudioProps as BrowserAudioProps,
  type VideoProps as BrowserVideoProps,
} from '@remotion/media';
import { AbsoluteFill, Audio as ServerAudio, Img, OffthreadVideo, Sequence, useCurrentFrame } from 'remotion';
import { ClipFx } from '../gl/ClipFx';
import { firstGlEffect } from '../gl/clipEffects';
import { selectEffectPreviewAdapter, type SelectedPreviewStatusListener } from '../gl/previewAdapter';
import { itemEditOpts, itemWindow, keptSegments } from '../transcript/edit';
import { hasOperationalTranscript } from '../transcript/types';
import { voiceIsolationMix } from '../audio/voiceMix';
import { backgroundFillAppearanceFor, backgroundFillFilter } from './backgroundFill';
import { clipFadeFactor, clipOpacityAt } from './clipFade';
import { volumeAtFrame } from './keyframes';
import { sourceFrameAt } from './sourceLimit';
import type { AspectFit, TimelineItem, TransitionItem } from './types';
import { isAudioTransition } from './types';
import { clampVisualBorderRadius, visibleVisualFrameRect } from './visualFrameGeometry';

type RuntimeVideoProps = Pick<BrowserVideoProps, 'src' | 'trimBefore' | 'trimAfter' | 'playbackRate' | 'volume' | 'style' | 'muted'> & {
  browserRenderer: boolean;
};

function RuntimeAudio({ browserRenderer, ...props }: BrowserAudioProps & { browserRenderer: boolean }) {
  return browserRenderer
    ? <BrowserAudio {...props} />
    : <ServerAudio {...props} preservePitch />;
}

function RuntimeVideo({ browserRenderer, ...props }: RuntimeVideoProps) {
  return browserRenderer
    ? <BrowserVideo {...props} />
    : <OffthreadVideo {...props} preservePitch />;
}

function MixedRuntimeAudio({ item, browserRenderer, volume, ...props }: Omit<BrowserAudioProps, 'src'> & {
  item: TimelineItem;
  browserRenderer: boolean;
}) {
  if (!item.denoisedSrc) {
    return <RuntimeAudio browserRenderer={browserRenderer} {...props} src={item.src!} volume={volume} />;
  }
  const mix = voiceIsolationMix(item.denoiseStrength);
  const scaledVolume = (gain: number): BrowserAudioProps['volume'] => (
    typeof volume === 'function' ? (frame) => volume(frame) * gain : (volume ?? 1) * gain
  );
  return (
    <>
      {mix.dry > 0 && <RuntimeAudio browserRenderer={browserRenderer} {...props} src={item.src!} volume={scaledVolume(mix.dry)} />}
      {mix.wet > 0 && <RuntimeAudio browserRenderer={browserRenderer} {...props} src={item.denoisedSrc} volume={scaledVolume(mix.wet)} />}
    </>
  );
}

export function VisualClipSurface({ item, fit, canvasW, canvasH, borderRadius, children }: {
  item: TimelineItem;
  fit: AspectFit;
  canvasW: number;
  canvasH: number;
  borderRadius: number;
  children: React.ReactNode;
}) {
  const sourceWidth = item.kind === 'solid' ? canvasW : item.width ?? canvasW;
  const sourceHeight = item.kind === 'solid' ? canvasH : item.height ?? canvasH;
  const frame = item.kind === 'solid'
    ? { x: 0, y: 0, width: canvasW, height: canvasH }
    : visibleVisualFrameRect(
      { width: canvasW, height: canvasH },
      { width: sourceWidth, height: sourceHeight },
      fit,
    );
  const resolvedRadius = clampVisualBorderRadius(borderRadius, frame);
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
      <div style={{
        position: 'relative',
        width: frame.width,
        height: frame.height,
        flexShrink: 0,
        overflow: resolvedRadius ? 'hidden' : undefined,
        borderRadius: resolvedRadius ? `${resolvedRadius}px` : undefined,
      }}>
        {children}
      </div>
    </AbsoluteFill>
  );
}

function audioCrossfadeMultiplier(item: TimelineItem, localFrame: number, transitions?: TransitionItem[]): number {
  if (!transitions?.length) return 1;
  let multiplier = 1;
  for (const transition of transitions) {
    if (transition.enabled === false || !isAudioTransition(transition.type)) continue;
    const duration = Math.max(1, transition.durationInFrames);
    if (transition.outgoingItemId === item.id && localFrame >= item.durationInFrames - duration) {
      multiplier *= 1 - Math.min(1, Math.max(0, (localFrame - item.durationInFrames + duration) / duration));
    }
    if (transition.incomingItemId === item.id && localFrame < duration) {
      multiplier *= Math.min(1, Math.max(0, localFrame / duration));
    }
  }
  return multiplier;
}

export function AudioClip({ item, fps, muted, gainAt, transitions, premountFor, browserRenderer }: {
  item: TimelineItem;
  fps: number;
  muted: boolean;
  gainAt: (frame: number) => number;
  transitions?: TransitionItem[];
  premountFor: number;
  browserRenderer: boolean;
}) {
  const volumeAt = (localFrame: number) => (muted ? 0 : volumeAtFrame(item, localFrame));
  if (!item.src) return null;
  if (hasOperationalTranscript(item)) {
    const deleted = new Set(item.deletedWordIdx ?? []);
    return <>{keptSegments(item.transcript, deleted, fps, item.startFrame, {
      ...itemEditOpts(item),
      window: itemWindow(item),
    }).map((segment, index) => (
      <Sequence key={`${item.id}_${index}`} from={segment.fromFrame} durationInFrames={segment.durFrames} premountFor={premountFor} name={item.name}>
        <MixedRuntimeAudio item={item} browserRenderer={browserRenderer} trimBefore={segment.srcStartFrame} trimAfter={segment.srcEndFrame}
          volume={(frame) => volumeAt(segment.fromFrame - item.startFrame + frame) * gainAt(segment.fromFrame + frame)
            * clipFadeFactor(segment.fromFrame - item.startFrame + frame, item.durationInFrames, item.fadeInFrames, item.fadeOutFrames)
            * audioCrossfadeMultiplier(item, segment.fromFrame - item.startFrame + frame, transitions)} />
      </Sequence>
    ))}</>;
  }
  return (
    <Sequence from={item.startFrame} durationInFrames={item.durationInFrames} premountFor={premountFor} name={item.name}>
      <MixedRuntimeAudio item={item} browserRenderer={browserRenderer} trimBefore={item.srcInFrame ?? 0} playbackRate={item.playbackRate ?? 1}
        volume={(frame) => volumeAt(frame) * gainAt(item.startFrame + frame)
          * clipFadeFactor(frame, item.durationInFrames, item.fadeInFrames, item.fadeOutFrames)
          * audioCrossfadeMultiplier(item, frame, transitions)} />
    </Sequence>
  );
}

export function ContinuousVideoAudio({ items, muted, gainAt, premountFor, browserRenderer }: {
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
    return volumeAtFrame(item, localFrame) * gainAt(timelineFrame)
      * clipFadeFactor(localFrame, item.durationInFrames, item.fadeInFrames, item.fadeOutFrames);
  };
  return (
    <Sequence from={first.startFrame} durationInFrames={duration} premountFor={premountFor} name={`${first.name}:audio`}>
      <MixedRuntimeAudio item={first} browserRenderer={browserRenderer} trimBefore={first.srcInFrame ?? 0}
        playbackRate={first.playbackRate ?? 1} volume={volume} />
    </Sequence>
  );
}

export function BackgroundFillLayer({ item, frameOffset, canvasW, canvasH, browserRenderer }: {
  item: TimelineItem;
  frameOffset: number;
  canvasW: number;
  canvasH: number;
  browserRenderer: boolean;
}) {
  const appearance = backgroundFillAppearanceFor(item, canvasW, canvasH);
  const opacity = clipOpacityAt(item, useCurrentFrame() + frameOffset);
  const trimBefore = sourceFrameAt(item, frameOffset);
  const filters = item.filters;
  const style: CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    transform: `scale(${appearance.overscanScale})`,
    filter: backgroundFillFilter(appearance, filters),
  };
  const effect = firstGlEffect(item);
  return (
    <AbsoluteFill aria-hidden style={{ opacity, overflow: 'hidden', pointerEvents: 'none' }}>
      {effect
        ? <AbsoluteFill style={style}>
            <ClipFx item={item} fit="cover" width={canvasW} height={canvasH} frameOffset={frameOffset} />
          </AbsoluteFill>
        : item.kind === 'image'
          ? <Img src={item.src!} style={style} />
          : <RuntimeVideo browserRenderer={browserRenderer} src={item.src!} trimBefore={trimBefore}
              playbackRate={item.playbackRate ?? 1} volume={0} muted style={style} />}
    </AbsoluteFill>
  );
}

interface MediaFillProps {
  item: TimelineItem;
  frameOffset: number;
  fit: AspectFit;
  muted: boolean;
  groupedAudio: boolean;
  canvasW: number;
  canvasH: number;
  borderRadius: number;
  gainAt: (frame: number) => number;
  browserRenderer: boolean;
  onPreviewStatus?: SelectedPreviewStatusListener;
}

type MediaVolume = (frame: number) => number;

function EffectMediaFill({ props, trimBefore, volume }: {
  props: MediaFillProps;
  trimBefore: number;
  volume: MediaVolume;
}) {
  const { item, fit, canvasW, canvasH, borderRadius, frameOffset, onPreviewStatus, groupedAudio, browserRenderer } = props;
  const frame = visibleVisualFrameRect(
    { width: canvasW, height: canvasH },
    { width: item.width ?? canvasW, height: item.height ?? canvasH },
    fit,
  );
  return (
    <>
      <VisualClipSurface item={item} fit={fit} canvasW={canvasW} canvasH={canvasH} borderRadius={borderRadius}>
        <ClipFx item={item} fit={fit === 'contain' ? 'cover' : fit} width={Math.max(1, Math.round(frame.width))}
          height={Math.max(1, Math.round(frame.height))} frameOffset={frameOffset} onPreviewStatus={onPreviewStatus} />
      </VisualClipSurface>
      {item.kind !== 'image' && !groupedAudio && <MixedRuntimeAudio item={item} browserRenderer={browserRenderer}
        trimBefore={trimBefore} playbackRate={item.playbackRate ?? 1} volume={volume} />}
    </>
  );
}

function PlainMediaFill({ props, trimBefore, volume }: {
  props: MediaFillProps;
  trimBefore: number;
  volume: MediaVolume;
}) {
  const { item, fit, canvasW, canvasH, borderRadius, groupedAudio, browserRenderer, muted } = props;
  const style: CSSProperties = { width: '100%', height: '100%', objectFit: fit === 'cover' ? 'cover' : 'contain' };
  const still = item.kind === 'image' || item.kind === 'gif' || item.kind === 'svg';
  return (
    <VisualClipSurface item={item} fit={fit} canvasW={canvasW} canvasH={canvasH} borderRadius={borderRadius}>
      {still
        ? <Img src={item.src!} style={style} />
        : item.denoisedSrc
          ? <><RuntimeVideo browserRenderer={browserRenderer} src={item.src!} trimBefore={trimBefore}
              playbackRate={item.playbackRate ?? 1} volume={0} muted style={style} />
            {!groupedAudio && <MixedRuntimeAudio item={item} browserRenderer={browserRenderer} trimBefore={trimBefore}
              playbackRate={item.playbackRate ?? 1} volume={volume} />}</>
          : <RuntimeVideo browserRenderer={browserRenderer} src={item.src!} trimBefore={trimBefore}
              playbackRate={item.playbackRate ?? 1} volume={groupedAudio ? 0 : volume}
              muted={groupedAudio || muted} style={style} />}
    </VisualClipSurface>
  );
}

export function MediaFill(props: MediaFillProps) {
  const { item, frameOffset, muted, groupedAudio, gainAt } = props;
  const trimBefore = sourceFrameAt(item, frameOffset);
  const volume = (frame: number) => {
    const localFrame = frame + frameOffset;
    if (localFrame < 0 || localFrame >= item.durationInFrames) return 0;
    return (muted ? 0 : volumeAtFrame(item, localFrame)) * gainAt(item.startFrame + localFrame)
      * clipFadeFactor(localFrame, item.durationInFrames, item.fadeInFrames, item.fadeOutFrames);
  };
  const adapter = selectEffectPreviewAdapter({
    declared: !!firstGlEffect(item),
    texturable: item.kind === 'video' || item.kind === 'image',
  });
  return adapter.adapter === 'gl-effect'
    ? <EffectMediaFill props={props} trimBefore={trimBefore} volume={volume} />
    : <PlainMediaFill props={{ ...props, groupedAudio }} trimBefore={trimBefore} volume={volume} />;
}
