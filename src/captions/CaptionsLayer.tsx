import { useMemo } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import type { CaptionsData, CaptionTemplate } from './types';
import { paginate, activePage, currentWordIndex } from './types';
import type { TimelineItem } from '../editor/types';
import type { TranscriptWord } from '../transcript/types';
import { retimeWords } from '../transcript/edit';

// Resolve the caption words as TIMELINE-ms words. Prefer the referenced audio
// item's transcript re-projected onto the edited timeline (captions follow
// deletions + silence compression); else shift the standalone words by offset.
function resolveWords(captions: CaptionsData, items: TimelineItem[], fps: number): TranscriptWord[] {
  const item = captions.sourceItemId ? items.find((it) => it.id === captions.sourceItemId) : undefined;
  if (item?.transcript?.length) {
    const del = new Set(item.deletedWordIdx ?? []);
    return retimeWords(item.transcript, del, fps, item.startFrame, { maxGapFrames: item.silenceFrames });
  }
  const offMs = ((captions.offsetFrames ?? 0) / fps) * 1000;
  return (captions.words ?? []).map((w) => ({ ...w, start: w.start + offMs, end: w.end + offMs }));
}

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
    position: 'absolute', left: 0, right: 0, display: 'flex', flexWrap: 'wrap',
    justifyContent: 'center', gap: '0.2em', padding: '0 10%', textAlign: 'center',
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

  const words = useMemo(() => resolveWords(captions, items, fps), [captions, items, fps]);
  const pages = useMemo(() => paginate(words, captions.pacing), [words, captions.pacing]);
  const page = activePage(pages, ms);
  if (!page) return null;
  const curIdx = currentWordIndex(page, ms);

  const isPlain = captions.template === 'plain';
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div style={containerStyle(captions.template)}>
        {isPlain && <PlainBg />}
        {page.words.map((w, i) => (
          <span key={i} style={{ position: 'relative', ...wordStyle(captions.template, i === curIdx) }}>{w.text}</span>
        ))}
      </div>
    </AbsoluteFill>
  );
}

// plain template shows words on a translucent bar; approximate with a wrapper bg.
function PlainBg() {
  return <div style={{ position: 'absolute', inset: '-12px -20px', background: 'rgba(0,0,0,0.6)', borderRadius: 12, zIndex: -1 }} />;
}
