import { captionTrackEntries, type TimelineState } from '../../editor/types';
import { captionPages } from '../../captions/exportCaptions';

/** Full horizontal content range for fit-to-view, including caption-only cues. */
export function timelineFitTotalFrames(state: TimelineState): number {
  const itemEnd = state.items.reduce(
    (end, item) => Math.max(end, item.startFrame + item.durationInFrames),
    0,
  );
  const captionPayloads = captionTrackEntries(state).flatMap((entry) => (
    entry.captions ? [entry.captions] : []
  ));
  if (state.captions && !captionPayloads.includes(state.captions)) {
    captionPayloads.push(state.captions);
  }
  const captionEnd = captionPayloads.reduce((trackEnd, captions) => {
    const cueEnd = captionPages(captions, state.items, state.fps).reduce(
      (end, page) => Math.max(
        end,
        Number.isFinite(page.end) ? Math.ceil(page.end * state.fps / 1000) : 0,
      ),
      0,
    );
    return Math.max(trackEnd, cueEnd);
  }, 0);
  const contentEnd = Math.max(itemEnd, captionEnd);
  return contentEnd > 0 ? Math.max(contentEnd, state.fps) : 0;
}
