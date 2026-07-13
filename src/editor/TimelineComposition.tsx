import { AbsoluteFill, Sequence } from 'remotion';
import { compileTemplate } from '../template-host';
import type { TimelineItem, TimelineState } from './types';

const GRID = 'repeating-conic-gradient(#242424 0% 25%, #1c1c1c 0% 50%) 50% / 40px 40px';

function ItemLayer({ item }: { item: TimelineItem }) {
  try {
    const Template = compileTemplate(item.code);
    return <Template item={{ props: item.props, width: item.width, height: item.height }} />;
  } catch (e) {
    return (
      <AbsoluteFill style={{ color: '#f88', fontFamily: 'monospace', fontSize: 20, padding: 40, whiteSpace: 'pre-wrap' }}>
        {(item.name + ' — compile error:\n') + (e instanceof Error ? e.message : String(e))}
      </AbsoluteFill>
    );
  }
}

// Renders the ENTIRE timeline. Visual tracks composite bottom-up: V1 then V2 on top.
export function TimelineComposition({ state }: { state: TimelineState }) {
  const visual = state.items.filter((it) => it.track === 'V1' || it.track === 'V2');
  const ordered = [...visual].sort((a, b) => (a.track === b.track ? 0 : a.track === 'V1' ? -1 : 1));

  return (
    <AbsoluteFill style={{ background: GRID }}>
      {ordered.map((item) => (
        <Sequence key={item.id} from={item.startFrame} durationInFrames={item.durationInFrames} layout="none" name={item.name}>
          <ItemLayer item={item} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}
