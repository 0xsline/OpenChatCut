import type { CaptionStyleOverride } from './styles';
import type { CaptionsData, CaptionTemplate } from './types';

/**
 * Applying a template replaces the current appearance while preserving cue
 * content, timing, placement, and lane metadata.
 */
export function captionTemplatePatch(
  captions: CaptionsData,
  template: CaptionTemplate,
  styleOverride?: CaptionStyleOverride,
): Partial<CaptionsData> {
  const sourceEntries = captions.sourceEntries?.map((entry) => {
    if (!entry.style) return entry;
    const { style: _style, ...rest } = entry;
    return rest;
  });
  return {
    template,
    styleOverride,
    ...(sourceEntries ? { sourceEntries } : {}),
  };
}
