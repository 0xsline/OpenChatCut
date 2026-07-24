import { useMemo } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import type { CaptionLayout, CaptionsData, CaptionTemplate } from './types';
import type { CaptionStyle } from './styles';
import { paginate, activePage, currentWordIndex, activeTranslation, joinCaptionWords } from './types';
import type { TimelineItem } from '../editor/types';
import { buildLaneGroups, type LanePage } from './lanes';
import { resolveCaptionWords, resolveCaptionWordIndices, applyWordOverrides } from './resolve';
import { containerStyle, effectivePreset, wordStyle } from './renderStyles';

const CAPTION_OVERLAY_STYLE = { pointerEvents: 'none', zIndex: 1 } as const;

// Renders the active caption page for the current frame. Lives inside the
// Remotion composition, so it shows in the Player preview AND burns into export.
export function CaptionsLayer({ captions, items }: { captions: CaptionsData; items: TimelineItem[] }) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const ms = (frame / fps) * 1000; // absolute timeline ms (words already re-timed)
  // Multi-lane scope(sourceEntries)→ lane engine; otherwise single-stream old path (bytes unchanged)
  if (captions.sourceEntries?.length) return <MultiLaneCaptions captions={captions} items={items} ms={ms} width={width} height={height} />;
  return <SingleStreamCaptions captions={captions} items={items} ms={ms} width={width} height={height} fps={fps} />;
}

function SingleStreamCaptions({ captions, items, ms, width, height, fps }: { captions: CaptionsData; items: TimelineItem[]; ms: number; width: number; height: number; fps: number }) {

  const words = useMemo(() => resolveCaptionWords(captions, items, fps), [captions, items, fps]);
  const indices = useMemo(() => resolveCaptionWordIndices(captions, items, fps), [captions, items, fps]);
  const preset = useMemo(() => effectivePreset(captions), [captions]);
  // Word-by-word overwriting (hide/change text/force page change) takes effect before paging and does not change transcript/timing.
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
    <AbsoluteFill style={CAPTION_OVERLAY_STYLE}>
      <div style={containerStyle(preset, captions.template, width, height, captions.layout)}>
        {preset.wholeLine ? (
          // The entire sentence is continuous: one text per page (no word gaps, no word-by-word highlighting), and the background wraps the entire line (classic black subtitles).
          <div style={{ ...wordStyle(preset, false), background: preset.background ?? 'transparent', borderRadius: 6, padding: preset.background ? '0.1em 0.42em' : 0, whiteSpace: 'pre-wrap' }}>
            {joinCaptionWords(page.words)}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: preset.displayMode === 'stacked' ? 'column' : 'row', flexWrap: 'wrap', justifyContent: 'center', gap: '0.2em' }}>
            {page.words.map((w, i) => (
              <span key={i} style={{ position: 'relative', ...wordStyle(preset, i === curIdx) }}>{w.text}</span>
            ))}
          </div>
        )}
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

// ── Multi-lane rendering (source three brothers positions/layout_policy/source_update)────────────────
// lanes.ts produces "anchor group → lane page"; here it is placed group by group and rendered lane by lane (each lane has its own
// per-source style override + karaoke highlighting). Shared block groups (anchor is not set) use captions.layout.
function MultiLaneCaptions({ captions, items, ms, width, height }: { captions: CaptionsData; items: TimelineItem[]; ms: number; width: number; height: number }) {
  const { fps } = useVideoConfig();
  const basePreset = useMemo(() => effectivePreset(captions), [captions]);
  const groups = useMemo(
    () => buildLaneGroups(captions, items, fps, ms, basePreset.wordsPerPage),
    [captions, items, fps, ms, basePreset.wordsPerPage],
  );
  if (!groups?.length) return null;
  return (
    <AbsoluteFill style={CAPTION_OVERLAY_STYLE}>
      {groups.map((g, gi) => {
        const layout: CaptionLayout | undefined = g.anchor
          ? { anchor: g.anchor, offsetXRatio: g.offsetXRatio, offsetYRatio: g.offsetYRatio }
          : captions.layout;
        return (
          <div key={gi} style={containerStyle(basePreset, captions.template, width, height, layout)}>
            {g.lanes.map((lane, li) => (
              <LaneCaption key={lane.entry.id || li} lane={lane} basePreset={basePreset} height={height} />
            ))}
          </div>
        );
      })}
    </AbsoluteFill>
  );
}

function LaneCaption({ lane, basePreset, height }: { lane: LanePage; basePreset: CaptionStyle; height: number }) {
  const preset: CaptionStyle = lane.entry.style ? { ...basePreset, ...lane.entry.style } : basePreset;
  const typography = {
    fontSize: height * preset.fontSize,
    fontFamily: `${preset.fontFamily}, system-ui, sans-serif`,
    fontWeight: preset.fontWeight,
    textTransform: preset.textTransform,
  } as const;
  if (preset.wholeLine) {
    return (
      <div style={{ ...typography, ...wordStyle(preset, false), background: preset.background ?? 'transparent', borderRadius: 6, padding: preset.background ? '0.1em 0.42em' : 0, whiteSpace: 'pre-wrap' }}>
        {joinCaptionWords(lane.page.words)}
      </div>
    );
  }
  return (
    <div style={{ ...typography, display: 'flex', flexDirection: preset.displayMode === 'stacked' ? 'column' : 'row', flexWrap: 'wrap', justifyContent: 'center', gap: '0.2em' }}>
      {lane.page.words.map((word, index) => (
        <span key={index} style={{ position: 'relative', ...wordStyle(preset, index === lane.curIdx) }}>{word.text}</span>
      ))}
    </div>
  );
}
