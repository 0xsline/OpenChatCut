import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, useCurrentFrame } from 'remotion';
import { compileTemplate } from '../template-host';
import { CaptionsLayer } from '../captions/CaptionsLayer';
import { keptSegments } from '../transcript/edit';
import type { AspectFit, TimelineItem, TimelineState } from './types';

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
  return <AbsoluteFill style={{ opacity: o, transform, filter }}>{children}</AbsoluteFill>;
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
      <Audio src={item.src!} trimBefore={item.srcInFrame ?? 0}
        volume={(f) => vol * fadeFactor(f, item.durationInFrames, item.fadeInFrames, item.fadeOutFrames)} />
    </Sequence>
  );
}

// Imported image / video fills the canvas by the fit mode (objectFit).
function MediaFill({ item, fit, muted }: { item: TimelineItem; fit: AspectFit; muted: boolean }) {
  const objectFit = fit === 'cover' ? 'cover' : 'contain';
  const style: React.CSSProperties = { width: '100%', height: '100%', objectFit };
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
      {item.kind === 'image'
        ? <Img src={item.src!} style={style} />
        : <OffthreadVideo src={item.src!} trimBefore={item.srcInFrame ?? 0}
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
export function TimelineComposition({ state }: { state: TimelineState }) {
  const isHidden = (t: TimelineItem['track']) => state.tracks?.[t]?.hidden ?? false;
  const isMuted = (t: TimelineItem['track']) => state.tracks?.[t]?.muted ?? false;
  const isVisual = (k: TimelineItem['kind']) => k === 'motion-graphic' || k === 'image' || k === 'video' || k === 'text';
  // hidden track = fully disabled (no picture, no sound)
  const visual = state.items.filter((it) => isVisual(it.kind) && (it.track === 'V1' || it.track === 'V2') && !isHidden(it.track));
  const ordered = [...visual].sort((a, b) => (a.track === b.track ? 0 : a.track === 'V1' ? -1 : 1));
  const audio = state.items.filter((it) => it.kind === 'audio' && it.src && !isHidden(it.track));
  const fit: AspectFit = state.fit ?? 'contain';

  return (
    <AbsoluteFill style={{ background: GRID }}>
      {ordered.map((item) => (
        <Sequence key={item.id} from={item.startFrame} durationInFrames={item.durationInFrames} layout="none" name={item.name}>
          <ClipWrapper item={item}>
            {item.kind === 'motion-graphic'
              ? <ItemLayer item={item} canvasW={state.width} canvasH={state.height} fit={fit} />
              : item.kind === 'text'
              ? <TextLayer item={item} canvasW={state.width} canvasH={state.height} fit={fit} />
              : <MediaFill item={item} fit={fit} muted={isMuted(item.track)} />}
          </ClipWrapper>
        </Sequence>
      ))}
      {audio.map((item) => (
        <AudioClip key={item.id} item={item} fps={state.fps} muted={isMuted(item.track)} />
      ))}
      {state.captions?.enabled && <CaptionsLayer captions={state.captions} items={state.items} />}
    </AbsoluteFill>
  );
}
