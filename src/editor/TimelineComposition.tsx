import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence } from 'remotion';
import { compileTemplate } from '../template-host';
import { CaptionsLayer } from '../captions/CaptionsLayer';
import { keptSegments } from '../transcript/edit';
import type { AspectFit, TimelineItem, TimelineState } from './types';

// One audio clip. With a transcript attached it renders the KEPT segments
// (deleted words' source ranges are skipped, remaining ranges play back-to-back);
// otherwise it plays the whole source.
function AudioClip({ item, fps }: { item: TimelineItem; fps: number }) {
  if (item.transcript && item.transcript.length) {
    const del = new Set(item.deletedWordIdx ?? []);
    return (
      <>
        {keptSegments(item.transcript, del, fps, item.startFrame, { maxGapFrames: item.silenceFrames }).map((seg, k) => (
          <Sequence key={`${item.id}_${k}`} from={seg.fromFrame} durationInFrames={seg.durFrames} name={item.name}>
            <Audio src={item.src!} trimBefore={seg.srcStartFrame} trimAfter={seg.srcEndFrame} volume={item.volume ?? 1} />
          </Sequence>
        ))}
      </>
    );
  }
  return (
    <Sequence from={item.startFrame} durationInFrames={item.durationInFrames} name={item.name}>
      <Audio src={item.src!} trimBefore={item.srcInFrame ?? 0} volume={item.volume ?? 1} />
    </Sequence>
  );
}

// Imported image / video fills the canvas by the fit mode (objectFit).
function MediaFill({ item, fit }: { item: TimelineItem; fit: AspectFit }) {
  const objectFit = fit === 'cover' ? 'cover' : 'contain';
  const style: React.CSSProperties = { width: '100%', height: '100%', objectFit };
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
      {item.kind === 'image'
        ? <Img src={item.src!} style={style} />
        : <OffthreadVideo src={item.src!} trimBefore={item.srcInFrame ?? 0} volume={item.volume ?? 1} style={style} />}
    </AbsoluteFill>
  );
}

const GRID = 'repeating-conic-gradient(#242424 0% 25%, #1c1c1c 0% 50%) 50% / 40px 40px';

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
  const isVisual = (k: TimelineItem['kind']) => k === 'motion-graphic' || k === 'image' || k === 'video';
  const visual = state.items.filter((it) => isVisual(it.kind) && (it.track === 'V1' || it.track === 'V2'));
  const ordered = [...visual].sort((a, b) => (a.track === b.track ? 0 : a.track === 'V1' ? -1 : 1));
  const audio = state.items.filter((it) => it.kind === 'audio' && it.src);
  const fit: AspectFit = state.fit ?? 'contain';

  return (
    <AbsoluteFill style={{ background: GRID }}>
      {ordered.map((item) => (
        <Sequence key={item.id} from={item.startFrame} durationInFrames={item.durationInFrames} layout="none" name={item.name}>
          {item.kind === 'motion-graphic'
            ? <ItemLayer item={item} canvasW={state.width} canvasH={state.height} fit={fit} />
            : <MediaFill item={item} fit={fit} />}
        </Sequence>
      ))}
      {audio.map((item) => (
        <AudioClip key={item.id} item={item} fps={state.fps} />
      ))}
      {state.captions?.enabled && <CaptionsLayer captions={state.captions} items={state.items} />}
    </AbsoluteFill>
  );
}
