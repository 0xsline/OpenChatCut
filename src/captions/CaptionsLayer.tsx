import { useMemo } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import type { CaptionsData, CaptionTemplate } from './types';
import { paginate, activePage, currentWordIndex, activeTranslation } from './types';
import type { TimelineItem } from '../editor/types';
import { resolveCaptionWords } from './resolve';
import { CAPTION_STYLE_BY_ID } from './styles';

// Per-template look. `active` marks the word currently being spoken.
function wordStyle(template: CaptionTemplate, active: boolean): React.CSSProperties {
  const preset = CAPTION_STYLE_BY_ID[template];
  return {
    color: active ? preset.highlightColor : preset.color,
    background: active && preset.highlightBackground ? preset.highlightBackground : 'transparent',
    borderRadius: preset.highlightBackground ? 6 : 0,
    padding: preset.highlightBackground ? '0 .14em' : 0,
    textShadow: preset.textShadow,
    WebkitTextStroke: preset.strokeWidth ? `${preset.strokeWidth}px ${preset.strokeColor}` : undefined,
  };
}

function containerStyle(template: CaptionTemplate, height: number): React.CSSProperties {
  const preset = CAPTION_STYLE_BY_ID[template];
  const base: React.CSSProperties = {
    position: 'absolute', left: 0, right: 0, display: 'flex', flexDirection: 'column',
    alignItems: 'center', gap: '0.1em', padding: '0 10%', textAlign: 'center',
    fontFamily: `${preset.fontFamily}, system-ui, sans-serif`, fontWeight: preset.fontWeight, lineHeight: 1.25,
    fontSize: height * preset.fontSize, textTransform: preset.textTransform,
  };
  return { ...base, bottom: template === 'netflix' ? '9%' : '8%' };
}

// Renders the active caption page for the current frame. Lives inside the
// Remotion composition, so it shows in the Player preview AND burns into export.
export function CaptionsLayer({ captions, items }: { captions: CaptionsData; items: TimelineItem[] }) {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const ms = (frame / fps) * 1000; // absolute timeline ms (words already re-timed)

  const words = useMemo(() => resolveCaptionWords(captions, items, fps), [captions, items, fps]);
  const preset = CAPTION_STYLE_BY_ID[captions.template];
  const pages = useMemo(() => paginate(words, captions.pacing, preset.wordsPerPage), [words, captions.pacing, preset.wordsPerPage]);
  const page = activePage(pages, ms);
  if (!page) return null;
  const curIdx = currentWordIndex(page, ms);
  const translated = captions.bilingual && captions.translation ? activeTranslation(captions.translation, ms) : null;

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div style={containerStyle(captions.template, height)}>
        <div style={{ display: 'flex', flexDirection: preset.displayMode === 'stacked' ? 'column' : 'row', flexWrap: 'wrap', justifyContent: 'center', gap: '0.2em' }}>
          {page.words.map((w, i) => (
            <span key={i} style={{ position: 'relative', ...wordStyle(captions.template, i === curIdx) }}>{w.text}</span>
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
