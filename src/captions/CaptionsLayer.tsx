import { useMemo } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import type { CaptionsData, CaptionTemplate, CaptionLayout } from './types';
import { paginate, activePage, currentWordIndex, activeTranslation } from './types';
import type { TimelineItem } from '../editor/types';
import { resolveCaptionWords, resolveCaptionWordIndices, applyWordOverrides } from './resolve';
import { CAPTION_STYLE_BY_ID, type CaptionStyle } from './styles';

// The effective look = template preset with the caption's custom styleOverride
// (source action=style) layered on top; unset override fields inherit the preset.
function effectivePreset(captions: CaptionsData): CaptionStyle {
  const preset = CAPTION_STYLE_BY_ID[captions.template];
  return captions.styleOverride ? { ...preset, ...captions.styleOverride } : preset;
}

// Per-word look from the (merged) preset. `active` marks the word being spoken.
function wordStyle(preset: CaptionStyle, active: boolean): React.CSSProperties {
  return {
    color: active ? preset.highlightColor : preset.color,
    background: active && preset.highlightBackground ? preset.highlightBackground : 'transparent',
    borderRadius: preset.highlightBackground ? 6 : 0,
    padding: preset.highlightBackground ? '0 .14em' : 0,
    textShadow: preset.textShadow,
    WebkitTextStroke: preset.strokeWidth ? `${preset.strokeWidth}px ${preset.strokeColor}` : undefined,
  };
}

/** Does the caption carry an explicit custom placement? */
function hasLayout(l: CaptionLayout | undefined): l is CaptionLayout {
  return !!l && (l.anchor !== undefined || l.offsetXRatio !== undefined || l.offsetYRatio !== undefined);
}

function containerStyle(preset: CaptionStyle, template: CaptionTemplate, width: number, height: number, layout: CaptionLayout | undefined): React.CSSProperties {
  const base: React.CSSProperties = {
    position: 'absolute', left: 0, right: 0, display: 'flex', flexDirection: 'column',
    gap: '0.1em', padding: '0 10%', lineHeight: 1.25,
    fontFamily: `${preset.fontFamily}, system-ui, sans-serif`, fontWeight: preset.fontWeight,
    fontSize: height * preset.fontSize, textTransform: preset.textTransform,
  };
  // Default (no custom layout): bottom-center, byte-identical to the prior behavior.
  if (!hasLayout(layout)) {
    return { ...base, alignItems: 'center', textAlign: 'center', bottom: template === 'netflix' ? '9%' : '8%' };
  }
  // Custom placement (source action=layout): 3×3 anchor + ratio offsets.
  const anchor = layout.anchor ?? 'bottom-center';
  const v = anchor.startsWith('top') ? 'top' : (anchor.startsWith('middle') || anchor === 'center') ? 'middle' : 'bottom';
  const h = anchor.endsWith('left') ? 'left' : anchor.endsWith('right') ? 'right' : 'center';
  const offX = (layout.offsetXRatio ?? 0) * width;
  const offY = (layout.offsetYRatio ?? 0) * height; // +ve = down
  const placed: React.CSSProperties = {
    ...base,
    alignItems: h === 'left' ? 'flex-start' : h === 'right' ? 'flex-end' : 'center',
    textAlign: h,
  };
  if (v === 'middle') return { ...placed, top: '50%', transform: `translateY(-50%) translate(${offX}px, ${offY}px)` };
  if (v === 'top') return { ...placed, top: height * 0.08, transform: `translate(${offX}px, ${offY}px)` };
  return { ...placed, bottom: height * 0.08, transform: `translate(${offX}px, ${-offY}px)` };
}

// Renders the active caption page for the current frame. Lives inside the
// Remotion composition, so it shows in the Player preview AND burns into export.
export function CaptionsLayer({ captions, items }: { captions: CaptionsData; items: TimelineItem[] }) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const ms = (frame / fps) * 1000; // absolute timeline ms (words already re-timed)

  const words = useMemo(() => resolveCaptionWords(captions, items, fps), [captions, items, fps]);
  const indices = useMemo(() => resolveCaptionWordIndices(captions, items), [captions, items]);
  const preset = useMemo(() => effectivePreset(captions), [captions]);
  // 逐词覆盖(隐藏/换文本/强制换页)在分页前生效,不改动 transcript/timing。
  const { words: displayWords, breakBefore } = useMemo(
    () => applyWordOverrides(words, indices, captions.wordOverrides),
    [words, indices, captions.wordOverrides],
  );
  const pages = useMemo(() => paginate(displayWords, captions.pacing, preset.wordsPerPage, breakBefore), [displayWords, captions.pacing, preset.wordsPerPage, breakBefore]);
  const page = activePage(pages, ms);
  if (!page) return null;
  const curIdx = currentWordIndex(page, ms);
  const translated = captions.bilingual && captions.translation ? activeTranslation(captions.translation, ms) : null;

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div style={containerStyle(preset, captions.template, width, height, captions.layout)}>
        <div style={{ display: 'flex', flexDirection: preset.displayMode === 'stacked' ? 'column' : 'row', flexWrap: 'wrap', justifyContent: 'center', gap: '0.2em' }}>
          {page.words.map((w, i) => (
            <span key={i} style={{ position: 'relative', ...wordStyle(preset, i === curIdx) }}>{w.text}</span>
          ))}
        </div>
        {translated?.text && <div style={translationStyle(captions.template)}>{translated.text}</div>}
      </div>
    </AbsoluteFill>
  );
}

// The translated second line: smaller, non-uppercase, sits under the original.
function translationStyle(template: CaptionTemplate): React.CSSProperties {
  const base: React.CSSProperties = { marginTop: '0.35em', textTransform: 'none', fontWeight: 600, textAlign: 'center' };
  if (template === 'tiktok') return { ...base, fontSize: 54, color: '#ffe14d', textShadow: '0 3px 12px rgba(0,0,0,0.7)' };
  if (template === 'netflix') return { ...base, fontSize: 42, color: '#e8e8e8', textShadow: '0 2px 6px rgba(0,0,0,0.9)' };
  return { ...base, fontSize: 40, color: '#ffe14d' };
}
