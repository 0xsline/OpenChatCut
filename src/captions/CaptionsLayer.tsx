import { useMemo } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import type { CaptionsData, CaptionTemplate } from './types';
import { paginate, activePage, currentWordIndex, activeTranslation } from './types';
import type { TimelineItem } from '../editor/types';
import { resolveCaptionWords } from './resolve';

// Per-template look. `active` marks the word currently being spoken.
function wordStyle(template: CaptionTemplate, active: boolean): React.CSSProperties {
  if (template === 'tiktok') {
    return {
      color: active ? '#111' : '#fff',
      background: active ? '#ffe14d' : 'transparent',
      borderRadius: 10, padding: '0 10px',
      textShadow: active ? 'none' : '0 3px 12px rgba(0,0,0,0.6)',
    };
  }
  if (template === 'netflix') {
    return { color: '#fff', textShadow: '0 2px 6px rgba(0,0,0,0.9)' };
  }
  return { color: active ? '#ffe14d' : '#fff' }; // plain
}

function containerStyle(template: CaptionTemplate): React.CSSProperties {
  const base: React.CSSProperties = {
    position: 'absolute', left: 0, right: 0, display: 'flex', flexDirection: 'column',
    alignItems: 'center', gap: '0.1em', padding: '0 10%', textAlign: 'center',
    fontFamily: 'Inter, system-ui, sans-serif', fontWeight: 800, lineHeight: 1.25,
  };
  if (template === 'tiktok') return { ...base, top: '58%', transform: 'translateY(-50%)', fontSize: 96, textTransform: 'uppercase' };
  if (template === 'netflix') return { ...base, bottom: '9%', fontSize: 60, fontWeight: 600 };
  // plain: bottom bar
  return { ...base, bottom: '8%', fontSize: 60 };
}

// Renders the active caption page for the current frame. Lives inside the
// Remotion composition, so it shows in the Player preview AND burns into export.
export function CaptionsLayer({ captions, items }: { captions: CaptionsData; items: TimelineItem[] }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ms = (frame / fps) * 1000; // absolute timeline ms (words already re-timed)

  const words = useMemo(() => resolveCaptionWords(captions, items, fps), [captions, items, fps]);
  const pages = useMemo(() => paginate(words, captions.pacing), [words, captions.pacing]);
  const page = activePage(pages, ms);
  if (!page) return null;
  const curIdx = currentWordIndex(page, ms);
  const translated = captions.bilingual && captions.translation ? activeTranslation(captions.translation, ms) : null;

  const isPlain = captions.template === 'plain';
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div style={containerStyle(captions.template)}>
        {isPlain && <PlainBg />}
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '0.2em' }}>
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

// plain template shows words on a translucent bar; approximate with a wrapper bg.
function PlainBg() {
  return <div style={{ position: 'absolute', inset: '-12px -20px', background: 'rgba(0,0,0,0.6)', borderRadius: 12, zIndex: -1 }} />;
}
