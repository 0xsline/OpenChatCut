import { collectReferencedFontFaces } from '../fonts/projectFonts';
import type { TimelineState } from './types';

export function timelineReadinessKey(state: TimelineState, dependencies: readonly TimelineState[] = []): string {
  const states = [state, ...dependencies];
  const templates = states.flatMap((entry) => entry.items
    .filter((item) => item.kind === 'motion-graphic' && item.code)
    .map((item) => item.code as string));
  return JSON.stringify([states.flatMap(collectReferencedFontFaces), templates]);
}
