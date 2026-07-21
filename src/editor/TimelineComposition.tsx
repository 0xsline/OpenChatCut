import { Audio as BrowserAudio, Video as BrowserVideo, type AudioProps as BrowserAudioProps, type VideoProps as BrowserVideoProps } from '@remotion/media';
import { AbsoluteFill, Audio as ServerAudio, Img, OffthreadVideo, Sequence, getRemotionEnvironment, useCurrentFrame } from 'remotion';
import { compileTemplate } from '../template-host';
import { CaptionsLayer } from '../captions/CaptionsLayer';
import { GlTransition } from '../gl/GlTransition';
import { ClipFx } from '../gl/ClipFx';
import { firstGlEffect } from '../gl/clipEffects';
import { ALL_FX, registerCustomFx } from '../gl/fx/effects';
import { itemWindow, keptSegments } from '../transcript/edit';
import { zoomAt } from './zoom';
import { sampleKeyframes } from './keyframes';
import { loadTimelineFonts } from '../fonts/projectFonts';
import { CSS_TRANSITION_TYPES, GLSL_TRANSITION_TYPES, isAudioTransition, isRasterMediaKind, isVisualItemKind, timelineTrackIds, trackKind } from './types';
import type { AspectFit, CssTransitionType, GlslTransitionType, KeyframeProp, TimelineItem, TimelineState, TransitionDirection, TransitionItem, Watermark } from './types';

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
// Items WITHOUT keyframes take the exact pre-keyframe code path (回归红线).
function ClipWrapper({ item, children }: { item: TimelineItem; children: React.ReactNode }) {
  const frame = useCurrentFrame();
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
  return <AbsoluteFill style={{ opacity, transform, filter }}>{inner}</AbsoluteFill>;
}

// ── Transitions, with CSS approximations for the GLSL set ─────────────────
function smoothstep(x: number): number { const c = Math.max(0, Math.min(1, x)); return c * c * (3 - 2 * c); }

interface Entrance { opacity: number; transform?: string; filter?: string; maskImage?: string; overlay?: { background: string; opacity: number }; }

// entrance style for the INCOMING clip at transition progress p (0→1). Mirrors
// Each transition has a distinct look: cross-dissolve = smoothstep mix, dip-to-black/
// flash = colored overlay peaking mid, soft-wipe = feathered directional reveal,
// whip-pan = directional slide + motion blur, luma-blend = dissolve + bloom.
function entranceStyle(type: CssTransitionType, p: number, dir: TransitionDirection): Entrance {
  const tri = 1 - Math.abs(2 * p - 1); // 0→1→0, peak at the midpoint
  switch (type) {
    case 'cross-dissolve':
      return { opacity: smoothstep(p) };
    case 'luma-blend':
      return { opacity: smoothstep(p), filter: `brightness(${1 + tri * 0.6})` };
    case 'dip-to-black':
      return { opacity: p >= 0.5 ? 1 : 0, overlay: { background: '#000', opacity: tri } };
    case 'flash':
      return { opacity: p >= 0.5 ? 1 : 0, overlay: { background: '#fff', opacity: tri * tri } };
    case 'soft-wipe': {
      const pct = p * 100;
      const edge = (d: string) => `linear-gradient(${d}, #000 ${Math.max(0, pct - 7).toFixed(2)}%, transparent ${Math.min(100, pct + 7).toFixed(2)}%)`;
      const d = dir === 'right' ? 'to left' : dir === 'up' ? 'to bottom' : dir === 'down' ? 'to top' : 'to right';
      return { opacity: 1, maskImage: edge(d) };
    }
    case 'whip-pan': {
      const off = (1 - p) * 100;
      const sign = dir === 'right' || dir === 'down' ? -1 : 1;
      const axis = dir === 'up' || dir === 'down' ? 'Y' : 'X';
      return { opacity: 1, transform: `translate${axis}(${sign * off}%)`, filter: `blur(${tri * 24}px)` };
    }
  }
}

// Wraps the incoming clip and drives its entrance over the transition window.
function TransitionIn({ type, L, dir, children }: { type: CssTransitionType; L: number; dir: TransitionDirection; children: React.ReactNode }) {
  const frame = useCurrentFrame();
  const p = L > 0 ? frame / L : 1;
  if (p >= 1) return <AbsoluteFill>{children}</AbsoluteFill>;
  const e = entranceStyle(type, Math.max(0, p), dir);
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ opacity: e.opacity, transform: e.transform, filter: e.filter, WebkitMaskImage: e.maskImage, maskImage: e.maskImage }}>{children}</AbsoluteFill>
      {e.overlay && <AbsoluteFill style={{ background: e.overlay.background, opacity: e.overlay.opacity }} />}
    </AbsoluteFill>
  );
}

// One audio clip. With a transcript attached it renders the KEPT segments
// (deleted words' source ranges are skipped, remaining ranges play back-to-back);
// otherwise it plays the whole source.
/** Playback audio path uses denoisedAudioAssetId when voice isolation is active. */
function audioSrc(item: TimelineItem): string {
  return item.denoisedSrc || item.src!;
}

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
  const vol = muted ? 0 : item.volume ?? 1;
  const src = audioSrc(item);
  if (item.transcript && item.transcript.length) {
    const del = new Set(item.deletedWordIdx ?? []);
    return (
      <>
        {keptSegments(item.transcript, del, fps, item.startFrame, {
          maxGapFrames: item.silenceFrames,
          gapCapsMs: item.gapCapsMs,
          playOrder: item.transcriptPlayOrder,
          window: itemWindow(item), // trim 手柄的 [srcIn, srcIn+dur) 切片(词↔帧一致)
        }).map((seg, k) => (
          <Sequence key={`${item.id}_${k}`} from={seg.fromFrame} durationInFrames={seg.durFrames} premountFor={premountFor} name={item.name}>
            <RuntimeAudio browserRenderer={browserRenderer} src={src} trimBefore={seg.srcStartFrame} trimAfter={seg.srcEndFrame}
              volume={(f) => vol * gainAt(seg.fromFrame + f) * audioCrossfadeMul(item, seg.fromFrame - item.startFrame + f, transitions)} />
          </Sequence>
        ))}
      </>
    );
  }
  return (
    <Sequence from={item.startFrame} durationInFrames={item.durationInFrames} premountFor={premountFor} name={item.name}>
      <RuntimeAudio browserRenderer={browserRenderer} src={src} trimBefore={item.srcInFrame ?? 0} playbackRate={item.playbackRate ?? 1}
        volume={(f) => vol
          * gainAt(item.startFrame + f)
          * fadeFactor(f, item.durationInFrames, item.fadeInFrames, item.fadeOutFrames)
          * audioCrossfadeMul(item, f, transitions)} />
    </Sequence>
  );
}

// Imported image / video / gif / svg fills the canvas by the fit mode (objectFit).
function MediaFill({ item, fit, muted, canvasW, canvasH, gainAt, browserRenderer }: { item: TimelineItem; fit: AspectFit; muted: boolean; canvasW: number; canvasH: number; gainAt: (frame: number) => number; browserRenderer: boolean }) {
  const objectFit = fit === 'cover' ? 'cover' : 'contain';
  const style: React.CSSProperties = { width: '100%', height: '100%', objectFit };
  const still = item.kind === 'image' || item.kind === 'gif' || item.kind === 'svg';
  // clip carries a WebGL effect → render pixels through the GL pass; video keeps
  // its audio via a separate muted-visual <Audio> (the GL source video is muted).
  if (firstGlEffect(item) && (item.kind === 'video' || item.kind === 'image')) {
    return (
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
        <ClipFx item={item} fit={fit} width={canvasW} height={canvasH} />
        {item.kind !== 'image' && (
          item.denoisedSrc ? (
            <RuntimeAudio browserRenderer={browserRenderer} src={item.denoisedSrc} trimBefore={item.srcInFrame ?? 0} playbackRate={item.playbackRate ?? 1}
              volume={(f) => (muted ? 0 : item.volume ?? 1) * gainAt(item.startFrame + f) * fadeFactor(f, item.durationInFrames, item.fadeInFrames, item.fadeOutFrames)} />
          ) : (
            <RuntimeAudio browserRenderer={browserRenderer} src={item.src!} trimBefore={item.srcInFrame ?? 0} playbackRate={item.playbackRate ?? 1}
              volume={(f) => (muted ? 0 : item.volume ?? 1) * gainAt(item.startFrame + f) * fadeFactor(f, item.durationInFrames, item.fadeInFrames, item.fadeOutFrames)} />
          )
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
              <RuntimeVideo browserRenderer={browserRenderer} src={item.src!} trimBefore={item.srcInFrame ?? 0} playbackRate={item.playbackRate ?? 1} volume={0} style={style} />
              <RuntimeAudio browserRenderer={browserRenderer} src={item.denoisedSrc} trimBefore={item.srcInFrame ?? 0} playbackRate={item.playbackRate ?? 1}
                volume={(f) => (muted ? 0 : item.volume ?? 1) * gainAt(item.startFrame + f) * fadeFactor(f, item.durationInFrames, item.fadeInFrames, item.fadeOutFrames)} />
            </>
          )
          : <RuntimeVideo browserRenderer={browserRenderer} src={item.src!} trimBefore={item.srcInFrame ?? 0} playbackRate={item.playbackRate ?? 1}
            volume={(f) => (muted ? 0 : item.volume ?? 1) * gainAt(item.startFrame + f) * fadeFactor(f, item.durationInFrames, item.fadeInFrames, item.fadeOutFrames)} style={style} />}
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
    const Template = compileTemplate(item.code ?? '');
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

// Renders the ENTIRE timeline. Visual tracks composite bottom-up: V1 then V2 on
// top. Audio items (A1/A2) play via <Audio> and produce no picture.
export type TimelineCompositionProps = Record<string, unknown> & {
  state: TimelineState;
  transparent?: boolean;
  /** Use @remotion/media so @remotion/web-renderer can decode media via WebCodecs. */
  browserRenderer?: boolean;
};

export function TimelineComposition({ state, transparent, browserRenderer = false }: TimelineCompositionProps) {
  loadTimelineFonts(state);
  // 非内置 fx(插件/submit_shader)def 随 state 自包含:渲染前同步注册进 ALL_FX,
  // 子组件(MediaFill 的 firstGlEffect 路由)首帧就解析得到——无头导出的新鲜浏览器
  // 没有内存注册表,全靠这里。幂等有守卫;渲染期改外部注册表是此处唯一的刻意例外。
  if (state.fxDefs) {
    for (const def of Object.values(state.fxDefs)) if (!(def.id in ALL_FX)) registerCustomFx(def);
  }
  const isHidden = (t: TimelineItem['track']) => state.tracks?.[t]?.hidden ?? false;
  const isMuted = (t: TimelineItem['track']) => state.tracks?.[t]?.muted ?? false;
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
  // 预览提前 2s 挂载各 clip(冻结首帧+透明):视频元素提前 seek/解码,GL 提前编译,
  // 消掉切点/转场窗口起点三个媒体元素同帧冷启动导致的"尾帧卡一下"。
  // 无头导出逐帧确定性渲染,预热只会拖慢导出,置 0。
  const premountFrames = getRemotionEnvironment().isRendering ? 0 : Math.round(state.fps * 2);

  // A transition straddles the cut: half retreats into outgoing, half
  // into incoming). Extend each clip's render window so both are visible across
  // the window, and drive the incoming clip's entrance over it. GLSL types run
  // the real fragment shader when BOTH clips are texturable
  // (video/image); with a DOM clip involved (MG/text — no GL texture, same
  // limit as any DOM layer) they fall back to a CSS cross-dissolve.
  const byId = new Map(state.items.map((it) => [it.id, it]));
  // gif 也排除:GlTransition 用 <Video> 挂源,gif 无法解码 → delayRender 卡死导出;走 CSS 回退
  const texturable = (it?: TimelineItem) => !!it && isRasterMediaKind(it.kind) && it.kind !== 'svg' && it.kind !== 'gif';
  const enabledTransitions = (state.transitions ?? []).filter((t) => t.enabled !== false);
  const visualTransitions = enabledTransitions.filter((t) => !isAudioTransition(t.type));
  const entranceOf = new Map<string, { type: CssTransitionType; L: number; dir: TransitionDirection }>();
  const extendBefore = new Map<string, number>();
  const extendAfter = new Map<string, number>();
  interface GlWindow { key: string; type: GlslTransitionType | 'custom-shader'; direction: TransitionDirection; from: number; L: number; outgoing: TimelineItem; incoming: TimelineItem; trimOut: number; trimIn: number; customFrag?: string; customUniforms?: Record<string, number> }
  const glWindows: GlWindow[] = [];
  for (const t of visualTransitions) {
    const half = Math.floor(t.durationInFrames / 2);
    extendBefore.set(t.incomingItemId, half);
    extendAfter.set(t.outgoingItemId, t.durationInFrames - half);
    const out = byId.get(t.outgoingItemId);
    const inc = byId.get(t.incomingItemId);
    if (GLSL_TRANSITION_TYPES.has(t.type) && texturable(out) && texturable(inc)) {
      const from = inc!.startFrame - half; // R = incoming.from - floor(L/2)
      glWindows.push({
        key: t.id,
        type: t.type as GlslTransitionType | 'custom-shader',
        direction: t.direction ?? 'left',
        from,
        L: t.durationInFrames,
        outgoing: out!,
        incoming: inc!,
        trimOut: Math.max(0, (out!.srcInFrame ?? 0) + (from - out!.startFrame)),
        trimIn: Math.max(0, (inc!.srcInFrame ?? 0) + (from - inc!.startFrame)),
        // custom-shader carries its GLSL + uniforms from the item to GlTransition
        ...(t.type === 'custom-shader' ? { customFrag: t.customFrag, customUniforms: t.customUniforms } : {}),
      });
    } else {
      // CSS entrance: native CSS type as-is; GLSL type over DOM clips → dissolve
      const cssType = CSS_TRANSITION_TYPES.has(t.type) ? t.type as CssTransitionType : 'cross-dissolve';
      entranceOf.set(t.incomingItemId, { type: cssType, L: t.durationInFrames, dir: t.direction ?? 'left' });
    }
  }

  return (
    <AbsoluteFill style={{ background: transparent ? undefined : GRID }}>
      {ordered.map((item) => {
        const eb = extendBefore.get(item.id) ?? 0;
        const ea = extendAfter.get(item.id) ?? 0;
        const entrance = entranceOf.get(item.id);
        const content = (
          <ClipWrapper item={item}>
            {item.kind === 'motion-graphic'
              ? <ItemLayer item={item} canvasW={state.width} canvasH={state.height} fit={fit} />
              : item.kind === 'text'
              ? <TextLayer item={item} canvasW={state.width} canvasH={state.height} fit={fit} />
              : item.kind === 'solid'
              ? <SolidLayer item={item} />
              : <MediaFill item={item} fit={fit} muted={isMuted(item.track)} gainAt={(frame) => duckGain(item.track, frame)} canvasW={state.width} canvasH={state.height} browserRenderer={browserRenderer} />}
          </ClipWrapper>
        );
        return (
          <Sequence key={item.id} from={item.startFrame - eb} durationInFrames={item.durationInFrames + eb + ea} premountFor={premountFrames} name={item.name}>
            {entrance
              ? <TransitionIn type={entrance.type} L={entrance.L} dir={entrance.dir}>{content}</TransitionIn>
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
            customFrag={w.customFrag} customUniforms={w.customUniforms}
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
      {state.captions?.enabled && <CaptionsLayer captions={state.captions} items={state.items} />}
      {state.watermark?.enabled && state.watermark.text
        && <WatermarkLayer watermark={state.watermark} canvasH={state.height} />}
    </AbsoluteFill>
  );
}
