import { useMemo } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import type { CaptionLayout, CaptionMotionPreset, CaptionPage, CaptionsData, CaptionTemplate } from './types';
import type { CaptionStyle } from './styles';
import { currentWordIndex, activeTranslation, joinCaptionWords } from './types';
import type { TimelineItem } from '../editor/types';
import { laneGroupsFromPages, type LanePage } from './lanes';
import { activeCaptionPages, buildCaptionPages } from './captionPages';
import { captionFlowStyle, captionTextStyle, containerStyle, effectivePreset } from './renderStyles';
import { buildCaptionWordRuns } from './captionWordRuns';
import { captionPageMotionStyle, captionWordMotionStyle } from './captionMotion';

const CAPTION_OVERLAY_STYLE = { pointerEvents: 'none', zIndex: 1 } as const;
const CAPTION_WORD_RUN_STYLE = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  maxWidth: '100%',
} as const;

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
  const preset = useMemo(() => effectivePreset(captions), [captions]);

  const pages = useMemo(() => buildCaptionPages(captions, items, fps), [captions, items, fps]);
  const page = activeCaptionPages(pages, ms)[0]?.page;
  if (!page) return null;
  const curIdx = currentWordIndex(page, ms);
  const translated = captions.bilingual && captions.translation ? activeTranslation(captions.translation, ms) : null;

  return (
    <AbsoluteFill style={CAPTION_OVERLAY_STYLE}>
      <div style={containerStyle(preset, captions.template, width, height, captions.layout)}>
        <div style={captionPageMotionStyle(captions.motionPreset, page, ms)}>
          {preset.wholeLine ? (
            <WholeLineCaption
              page={page}
              preset={preset}
              height={height}
              motionPreset={captions.motionPreset}
              ms={ms}
            />
          ) : (
            <CaptionWordFlow
              page={page}
              preset={preset}
              height={height}
              currentIndex={curIdx}
              motionPreset={captions.motionPreset}
              ms={ms}
            />
          )}
          {translated?.text && <div style={translationStyle(captions.template)}>{translated.text}</div>}
        </div>
      </div>
    </AbsoluteFill>
  );
}

function WholeLineCaption({
  page,
  preset,
  height,
  motionPreset,
  ms,
}: {
  page: CaptionPage;
  preset: CaptionStyle;
  height: number;
  motionPreset: CaptionMotionPreset | undefined;
  ms: number;
}) {
  return (
    <div style={{ ...captionTextStyle(preset, height, false, true), whiteSpace: 'pre-wrap' }}>
      {page.words.map((word, index) => {
        const previous = page.words[index - 1];
        const text = previous ? joinCaptionWords([previous, word]).slice(previous.text.length) : word.text;
        return (
          <span key={word.id ?? index} style={captionWordMotionStyle(motionPreset, word, ms)}>
            {text}
          </span>
        );
      })}
    </div>
  );
}

function CaptionWordFlow({
  page,
  preset,
  height,
  currentIndex,
  motionPreset,
  ms,
}: {
  page: CaptionPage;
  preset: CaptionStyle;
  height: number;
  currentIndex: number;
  motionPreset: CaptionMotionPreset | undefined;
  ms: number;
}) {
  const runs = buildCaptionWordRuns(page.words, preset.displayMode === 'stacked');
  return (
    <div style={captionFlowStyle(preset)}>
      {runs.map((run) => (
        <span key={run.words[0]?.id ?? run.startIndex} style={CAPTION_WORD_RUN_STYLE}>
          {run.words.map((word, runIndex) => {
            const index = run.startIndex + runIndex;
            return (
              <span
                key={word.id ?? index}
                style={{
                  position: 'relative',
                  ...captionTextStyle(preset, height, index === currentIndex),
                  ...captionWordMotionStyle(motionPreset, word, ms),
                }}
              >
                {word.text}
              </span>
            );
          })}
        </span>
      ))}
    </div>
  );
}

// The translated second line: smaller, non-uppercase, sits under the original.
function translationStyle(template: CaptionTemplate): React.CSSProperties {
  const base: React.CSSProperties = { marginTop: '0.35em', textTransform: 'none', fontWeight: 600, textAlign: 'center' };
  if (template === 'tiktok') return { ...base, fontSize: 54, color: '#ffe14d', textShadow: '0 3px 12px rgba(0,0,0,0.7)' };
  if (template === 'netflix') return { ...base, fontSize: 42, color: '#e8e8e8', textShadow: '0 2px 6px rgba(0,0,0,0.9)' };
  return { ...base, fontSize: 40, color: '#ffe14d' };
}

// ──Multi-lane rendering (source three brothers positions/layout_policy/source_update)────────────────
// lanes.ts produces "anchor group → lane page"; here it is placed group by group and rendered lane by lane (each lane has its own
// per-source style override + karaoke highlighting). Shared block groups (anchor is not set) use captions.layout.
function MultiLaneCaptions({ captions, items, ms, width, height }: { captions: CaptionsData; items: TimelineItem[]; ms: number; width: number; height: number }) {
  const { fps } = useVideoConfig();
  const basePreset = useMemo(() => effectivePreset(captions), [captions]);
  // Pages depend only on captions/items/fps: computed once per change, NOT per
  // animation frame. ms changes every tick and must not invalidate the whole
  // merge + pagination pipeline (the freeze for large merged source sets).
  const lanePages = useMemo(() => buildCaptionPages(captions, items, fps), [captions, items, fps]);
  const groups = useMemo(() => laneGroupsFromPages(lanePages, captions, ms), [lanePages, captions, ms]);
  if (!groups?.length) return null;
  return (
    <AbsoluteFill style={CAPTION_OVERLAY_STYLE}>
      {groups.map((g, gi) => {
        const layout: CaptionLayout | undefined = g.anchor
          ? {
              anchor: g.anchor,
              offsetXRatio: g.offsetXRatio,
              offsetYRatio: g.offsetYRatio,
              scale: g.scale,
              rotation: g.rotation,
              opacity: g.opacity,
            }
          : captions.layout;
        return (
          <div key={gi} style={containerStyle(basePreset, captions.template, width, height, layout)}>
            {g.lanes.map((lane, li) => (
              <LaneCaption
                key={lane.entry.id || li}
                lane={lane}
                basePreset={basePreset}
                height={height}
                motionPreset={captions.motionPreset}
                ms={ms}
              />
            ))}
          </div>
        );
      })}
    </AbsoluteFill>
  );
}

function LaneCaption({
  lane,
  basePreset,
  height,
  motionPreset,
  ms,
}: {
  lane: LanePage;
  basePreset: CaptionStyle;
  height: number;
  motionPreset: CaptionsData['motionPreset'];
  ms: number;
}) {
  const preset: CaptionStyle = lane.entry.style ? { ...basePreset, ...lane.entry.style } : basePreset;
  const content = preset.wholeLine ? (
    <WholeLineCaption
      page={lane.page}
      preset={preset}
      height={height}
      motionPreset={motionPreset}
      ms={ms}
    />
  ) : (
    <CaptionWordFlow
      page={lane.page}
      preset={preset}
      height={height}
      currentIndex={lane.curIdx}
      motionPreset={motionPreset}
      ms={ms}
    />
  );
  return <div style={captionPageMotionStyle(motionPreset, lane.page, ms)}>{content}</div>;
}
