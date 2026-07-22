import { useEffect, useMemo, useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { TimelineItem, TrackId } from '../editor/types';
import { useT } from '../i18n/locale';
import { mediaOnTrack, isLikelyNonSpeech, pickDefaultTrack, trackTitle, type TranscriptTrackOption } from '../transcript/trackOptions';
import { msToFrame } from '../transcript/types';
import { CaptionsControls } from './CaptionsControls';
import { newManualCaptions } from './manualCaptions';
import { buildTranslation } from './translate';
import type { CaptionsData } from './types';

interface Props {
  playerRef: RefObject<PlayerRef | null>;
  fps: number;
  items: TimelineItem[];
  trackOptions: TranscriptTrackOption[];
  captions: CaptionsData | null;
  onSetCaptions: (captions: CaptionsData | null) => void;
  onUpdateCaptions: (patch: Partial<CaptionsData>) => void;
}

export function CaptionsPanel(props: Props) {
  const { playerRef, fps, items, trackOptions, captions, onSetCaptions, onUpdateCaptions } = props;
  const defaultTrack = useMemo(() => pickDefaultTrack(trackOptions, items), [trackOptions, items]);
  const [track, setTrack] = useState<TrackId | null>(defaultTrack);
  const selectable = useMemo(() => trackOptions.filter((option) => mediaOnTrack(items, option.id).length), [trackOptions, items]);
  useEffect(() => {
    if (!track || !selectable.some((option) => option.id === track)) setTrack(defaultTrack);
  }, [defaultTrack, selectable, track]);
  const transcribed = useMemo(() => captionClips(items, track).filter((item) => item.transcript?.length), [items, track]);
  const translation = useCaptionTranslation(captions, items, fps, onUpdateCaptions);
  const generate = () => {
    if (!transcribed.length) return;
    const sources = transcribed.map((item) => item.id);
    onSetCaptions({ enabled: true, template: captions?.template ?? 'black-bar', pacing: captions?.pacing ?? 'phrase', sourceItemId: sources[0]!, sources: sources.length > 1 ? sources : undefined, sourceMode: sources.length > 1 ? 'item' : undefined, bilingual: false });
  };
  return (
    <div className="cc-captions-workspace">
      <CaptionSourceBar options={selectable} track={track} count={transcribed.length} onChange={setTrack} />
      <CaptionsControls standalone captions={captions} hasTranscript={transcribed.length > 0} sourceVariants={(captions?.sourceItemId ? items.find((item) => item.id === captions.sourceItemId)?.variants : undefined) ?? []} items={items} fps={fps} onSeekMs={(ms) => playerRef.current?.seekTo(msToFrame(ms, fps))} onGenerate={generate} onCreateManual={() => onSetCaptions(newManualCaptions())} getPlayheadMs={() => ((playerRef.current?.getCurrentFrame() ?? 0) / fps) * 1000} onUpdate={onUpdateCaptions} onRemove={() => onSetCaptions(null)} onTranslate={translation.run} translating={translation.running} translateError={translation.error} />
    </div>
  );
}

function captionClips(items: TimelineItem[], track: TrackId | null): TimelineItem[] {
  const clips = track ? mediaOnTrack(items, track) : [];
  const speech = clips.filter((item) => !isLikelyNonSpeech(item));
  return speech.length ? speech : clips;
}

function CaptionSourceBar({ options, track, count, onChange }: { options: TranscriptTrackOption[]; track: TrackId | null; count: number; onChange: (track: TrackId) => void }) {
  const t = useT();
  return (
    <div className="cc-captions-sourcebar">
      <label htmlFor="cc-caption-source">{t('字幕来源')}</label>
      <select id="cc-caption-source" className="cc-cap-select" value={track ?? ''} disabled={!options.length} onChange={(event) => onChange(event.target.value)}>
        {!options.length && <option value="">{t('无可用轨道')}</option>}
        {options.map((option) => <option key={option.id} value={option.id}>{trackTitle(option)}</option>)}
      </select>
      <span>{count ? t('已转写 {n} 段', { n: count }) : t('当前轨道未转写')}</span>
    </div>
  );
}

function useCaptionTranslation(captions: CaptionsData | null, items: TimelineItem[], fps: number, onUpdate: (patch: Partial<CaptionsData>) => void) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (lang: string) => {
    if (!captions || running) return;
    setRunning(true);
    setError(null);
    try {
      const cues = await buildTranslation(captions, items, fps, lang);
      onUpdate({ bilingual: true, translationLang: lang, translation: cues });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  };
  return { running, error, run };
}
