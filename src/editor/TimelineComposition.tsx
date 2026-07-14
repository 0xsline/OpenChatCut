import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, useCurrentFrame } from 'remotion';
import { compileTemplate } from '../template-host';
import { CaptionsLayer } from '../captions/CaptionsLayer';
import { GlTransition } from '../gl/GlTransition';
import { ClipFx, firstGlEffect } from '../gl/ClipFx';
import { keptSegments } from '../transcript/edit';
import { zoomAt } from './zoom';
import { GLSL_TRANSITION_TYPES } from './types';
import type { AspectFit, CssTransitionType, GlslTransitionType, TimelineItem, TimelineState, TransitionDirection } from './types';

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
function ClipWrapper({ item, children }: { item: TimelineItem; children: React.ReactNode }) {
  const frame = useCurrentFrame();
  const o = fadeFactor(frame, item.durationInFrames, item.fadeInFrames, item.fadeOutFrames);
  const t = item.transform;
  const transform = t
    ? `translate(${t.x ?? 0}%, ${t.y ?? 0}%) rotate(${t.rotation ?? 0}deg) scale(${t.scale ?? 1})`
    : undefined;
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
  return <AbsoluteFill style={{ opacity: o, transform, filter }}>{inner}</AbsoluteFill>;
}

// ── transitions (source transition_item, CSS approximation of the GLSL set) ──
function smoothstep(x: number): number { const c = Math.max(0, Math.min(1, x)); return c * c * (3 - 2 * c); }

interface Entrance { opacity: number; transform?: string; filter?: string; maskImage?: string; overlay?: { background: string; opacity: number }; }

// entrance style for the INCOMING clip at transition progress p (0→1). Mirrors
// each source transition's look: cross-dissolve = smoothstep mix, dip-to-black/
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
function AudioClip({ item, fps, muted }: { item: TimelineItem; fps: number; muted: boolean }) {
  const vol = muted ? 0 : item.volume ?? 1;
  if (item.transcript && item.transcript.length) {
    const del = new Set(item.deletedWordIdx ?? []);
    return (
      <>
        {keptSegments(item.transcript, del, fps, item.startFrame, { maxGapFrames: item.silenceFrames }).map((seg, k) => (
          <Sequence key={`${item.id}_${k}`} from={seg.fromFrame} durationInFrames={seg.durFrames} name={item.name}>
            <Audio src={item.src!} trimBefore={seg.srcStartFrame} trimAfter={seg.srcEndFrame} volume={vol} />
          </Sequence>
        ))}
      </>
    );
  }
  return (
    <Sequence from={item.startFrame} durationInFrames={item.durationInFrames} name={item.name}>
      <Audio src={item.src!} trimBefore={item.srcInFrame ?? 0} playbackRate={item.playbackRate ?? 1}
        volume={(f) => vol * fadeFactor(f, item.durationInFrames, item.fadeInFrames, item.fadeOutFrames)} />
    </Sequence>
  );
}

// Imported image / video fills the canvas by the fit mode (objectFit).
function MediaFill({ item, fit, muted, canvasW, canvasH }: { item: TimelineItem; fit: AspectFit; muted: boolean; canvasW: number; canvasH: number }) {
  const objectFit = fit === 'cover' ? 'cover' : 'contain';
  const style: React.CSSProperties = { width: '100%', height: '100%', objectFit };
  // clip carries a WebGL effect → render pixels through the GL pass; video keeps
  // its audio via a separate muted-visual <Audio> (the GL source video is muted).
  if (firstGlEffect(item)) {
    return (
      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
        <ClipFx item={item} fit={fit} width={canvasW} height={canvasH} />
        {item.kind !== 'image' && (
          <Audio src={item.src!} trimBefore={item.srcInFrame ?? 0} playbackRate={item.playbackRate ?? 1}
            volume={(f) => (muted ? 0 : item.volume ?? 1) * fadeFactor(f, item.durationInFrames, item.fadeInFrames, item.fadeOutFrames)} />
        )}
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
      {item.kind === 'image'
        ? <Img src={item.src!} style={style} />
        : <OffthreadVideo src={item.src!} trimBefore={item.srcInFrame ?? 0} playbackRate={item.playbackRate ?? 1}
            volume={(f) => (muted ? 0 : item.volume ?? 1) * fadeFactor(f, item.durationInFrames, item.fadeInFrames, item.fadeOutFrames)} style={style} />}
    </AbsoluteFill>
  );
}

const GRID = 'repeating-conic-gradient(#242424 0% 25%, #1c1c1c 0% 50%) 50% / 40px 40px';

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
// canvas by the fit mode (source manage_timelines `fit`): contain letterboxes,
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
export function TimelineComposition({ state, transparent }: { state: TimelineState; transparent?: boolean }) {
  const isHidden = (t: TimelineItem['track']) => state.tracks?.[t]?.hidden ?? false;
  const isMuted = (t: TimelineItem['track']) => state.tracks?.[t]?.muted ?? false;
  const isVisual = (k: TimelineItem['kind']) => k === 'motion-graphic' || k === 'image' || k === 'video' || k === 'text';
  // hidden track = fully disabled (no picture, no sound)
  const visual = state.items.filter((it) => isVisual(it.kind) && (it.track === 'V1' || it.track === 'V2') && !isHidden(it.track));
  // paint V1 below V2; within a track paint earlier clips first so a transition's
  // incoming clip (later startFrame) composites on top of the outgoing one.
  const ordered = [...visual].sort((a, b) => (a.track === b.track ? a.startFrame - b.startFrame : a.track === 'V1' ? -1 : 1));
  const audio = state.items.filter((it) => it.kind === 'audio' && it.src && !isHidden(it.track));
  const fit: AspectFit = state.fit ?? 'contain';

  // A transition straddles the cut (source: half retreats into outgoing, half
  // into incoming). Extend each clip's render window so both are visible across
  // the window, and drive the incoming clip's entrance over it. GLSL types run
  // the source's real fragment shader when BOTH clips are texturable
  // (video/image); with a DOM clip involved (MG/text — no GL texture, same
  // limit as the source's DOM layers) they fall back to a CSS cross-dissolve.
  const byId = new Map(state.items.map((it) => [it.id, it]));
  const texturable = (it?: TimelineItem) => it?.kind === 'video' || it?.kind === 'image';
  const enabledTransitions = (state.transitions ?? []).filter((t) => t.enabled !== false);
  const entranceOf = new Map<string, { type: CssTransitionType; L: number; dir: TransitionDirection }>();
  const extendBefore = new Map<string, number>();
  const extendAfter = new Map<string, number>();
  interface GlWindow { key: string; type: GlslTransitionType; from: number; L: number; outgoing: TimelineItem; incoming: TimelineItem; trimOut: number; trimIn: number }
  const glWindows: GlWindow[] = [];
  for (const t of enabledTransitions) {
    const half = Math.floor(t.durationInFrames / 2);
    extendBefore.set(t.incomingItemId, half);
    extendAfter.set(t.outgoingItemId, t.durationInFrames - half);
    const out = byId.get(t.outgoingItemId);
    const inc = byId.get(t.incomingItemId);
    if (GLSL_TRANSITION_TYPES.has(t.type) && texturable(out) && texturable(inc)) {
      const from = inc!.startFrame - half; // R = incoming.from - floor(L/2)
      glWindows.push({
        key: t.id,
        type: t.type as GlslTransitionType,
        from,
        L: t.durationInFrames,
        outgoing: out!,
        incoming: inc!,
        trimOut: Math.max(0, (out!.srcInFrame ?? 0) + (from - out!.startFrame)),
        trimIn: Math.max(0, (inc!.srcInFrame ?? 0) + (from - inc!.startFrame)),
      });
    } else {
      // CSS entrance: native CSS type as-is; GLSL type over DOM clips → dissolve
      const cssType = GLSL_TRANSITION_TYPES.has(t.type) ? 'cross-dissolve' : (t.type as CssTransitionType);
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
              : <MediaFill item={item} fit={fit} muted={isMuted(item.track)} canvasW={state.width} canvasH={state.height} />}
          </ClipWrapper>
        );
        return (
          <Sequence key={item.id} from={item.startFrame - eb} durationInFrames={item.durationInFrames + eb + ea} layout="none" name={item.name}>
            {entrance
              ? <TransitionIn type={entrance.type} L={entrance.L} dir={entrance.dir}>{content}</TransitionIn>
              : content}
          </Sequence>
        );
      })}
      {/* GLSL transition windows: painted over both clips, beneath captions */}
      {glWindows.map((w) => (
        <Sequence key={w.key} from={w.from} durationInFrames={w.L} layout="none" name={`tr:${w.type}`}>
          <GlTransition
            type={w.type} L={w.L} windowStart={w.from}
            outgoing={w.outgoing} incoming={w.incoming} trimOut={w.trimOut} trimIn={w.trimIn}
            width={state.width} height={state.height} fit={fit}
          />
        </Sequence>
      ))}
      {audio.map((item) => (
        <AudioClip key={item.id} item={item} fps={state.fps} muted={isMuted(item.track)} />
      ))}
      {state.captions?.enabled && <CaptionsLayer captions={state.captions} items={state.items} />}
    </AbsoluteFill>
  );
}
