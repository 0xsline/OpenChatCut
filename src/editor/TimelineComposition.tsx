import { AbsoluteFill, Audio, Sequence } from 'remotion';
import { compileTemplate } from '../template-host';
import { CaptionsLayer } from '../captions/CaptionsLayer';
import { keptSegments } from '../transcript/edit';
import type { TimelineItem, TimelineState } from './types';

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
      <Audio src={item.src!} volume={item.volume ?? 1} />
    </Sequence>
  );
}

const GRID = 'repeating-conic-gradient(#242424 0% 25%, #1c1c1c 0% 50%) 50% / 40px 40px';

function ItemLayer({ item }: { item: TimelineItem }) {
  try {
    const Template = compileTemplate(item.code ?? '');
    return <Template item={{ props: item.props ?? {}, width: item.width ?? 1920, height: item.height ?? 1080 }} />;
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
  const visual = state.items.filter((it) => it.kind === 'motion-graphic' && (it.track === 'V1' || it.track === 'V2'));
  const ordered = [...visual].sort((a, b) => (a.track === b.track ? 0 : a.track === 'V1' ? -1 : 1));
  const audio = state.items.filter((it) => it.kind === 'audio' && it.src);

  return (
    <AbsoluteFill style={{ background: GRID }}>
      {ordered.map((item) => (
        <Sequence key={item.id} from={item.startFrame} durationInFrames={item.durationInFrames} layout="none" name={item.name}>
          <ItemLayer item={item} />
        </Sequence>
      ))}
      {audio.map((item) => (
        <AudioClip key={item.id} item={item} fps={state.fps} />
      ))}
      {state.captions?.enabled && <CaptionsLayer captions={state.captions} items={state.items} />}
    </AbsoluteFill>
  );
}
