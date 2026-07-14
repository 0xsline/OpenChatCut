import { useEffect, useMemo, useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { TimelineItem, TrackId, TrackKind } from '../editor/types';
import { useTranscript } from './useTranscript';
import { msToFrame, type TranscriptWord } from './types';
import { toParagraphs, toSegments, analyzeSilences, type IndexedWord } from './segment';
import { ParagraphView, SegmentView } from './TranscriptViews';
import { CaptionsControls } from '../captions/CaptionsControls';
import type { CaptionsData } from '../captions/types';
import { buildTranslation } from '../captions/translate';
import { Icon } from '../components/icons';

/** Track row for the transcript selector (alias + human name, never raw UUID alone). */
export interface TranscriptTrackOption {
  id: TrackId;
  alias: string;
  name?: string;
  kind: TrackKind;
}

interface TranscriptPanelProps {
  playerRef: RefObject<PlayerRef | null>;
  fps: number;
  items: TimelineItem[];
  /** ordered tracks with A1/V1 aliases from EditorCore */
  trackOptions: TranscriptTrackOption[];
  captions: CaptionsData | null;
  onSetCaptions: (c: CaptionsData | null) => void;
  onUpdateCaptions: (patch: Partial<CaptionsData>) => void;
  onSetItemTranscript: (id: string, words: TranscriptWord[]) => void;
  onToggleWord: (id: string, idx: number) => void;
  onCleanScript: (id: string, opts: { silenceFrames?: number; removeFillers: boolean }) => void;
  onClearEdits: (id: string) => void;
}

function mediaOnTrack(items: TimelineItem[], track: TrackId): TimelineItem[] {
  return items
    .filter((it) => it.track === track && !!it.src && (it.kind === 'audio' || it.kind === 'video'))
    .sort((a, b) => a.startFrame - b.startFrame);
}

/** Background music / SFX — not for speech transcription by default. */
function isLikelyNonSpeech(it: TimelineItem): boolean {
  const n = (it.name ?? '').toLowerCase();
  return /背景音乐|bgm|\bmusic\b|score|ambient|音效|whoosh|sfx|instrumental/.test(n);
}

function clipLabel(it: TimelineItem): string {
  const n = it.name?.trim() || it.id;
  return n.length > 32 ? `${n.slice(0, 30)}…` : n;
}

function trackTitle(t: TranscriptTrackOption): string {
  const name = t.name?.trim();
  if (name && name !== t.alias) return `${t.alias} · ${name}`;
  return t.alias;
}

function pickDefaultTrack(options: TranscriptTrackOption[], items: TimelineItem[]): TrackId | null {
  // Prefer audio tracks with speech-like clips (配音 / VO), skip pure BGM lanes.
  const scored = options
    .filter((t) => t.kind === 'audio')
    .map((t) => {
      const clips = mediaOnTrack(items, t.id);
      const speech = clips.filter((c) => !isLikelyNonSpeech(c));
      const name = `${t.name ?? ''} ${t.alias}`.toLowerCase();
      let score = speech.length * 10 + clips.length;
      if (/配音|voice|vo|旁白|口播|anchor/.test(name)) score += 50;
      if (/背景|music|bgm|follower/.test(name)) score -= 40;
      if (!clips.length) score -= 100;
      return { id: t.id, score, speech: speech.length };
    })
    .sort((a, b) => b.score - a.score);
  if (scored[0] && scored[0].score > -50) return scored[0].id;
  // fallback: any track with media
  const any = options.find((t) => mediaOnTrack(items, t.id).length > 0);
  return any?.id ?? options[0]?.id ?? null;
}

export function TranscriptPanel({
  playerRef, fps, items, trackOptions, captions, onSetCaptions, onUpdateCaptions,
  onSetItemTranscript, onToggleWord, onCleanScript, onClearEdits,
}: TranscriptPanelProps) {
  const { status, error, progressNote, runMany, reset } = useTranscript();
  const defaultId = useMemo(() => pickDefaultTrack(trackOptions, items), [trackOptions, items]);
  const [track, setTrack] = useState<TrackId | null>(defaultId);
  const [view, setView] = useState<'paragraph' | 'segment'>('paragraph');
  const [editMode, setEditMode] = useState(false);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [compressSec, setCompressSec] = useState(0.5);
  const [removeFillers, setRemoveFillers] = useState(true);
  const [pauseResult, setPauseResult] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  const [translateError, setTranslateError] = useState<string | null>(null);
  const [focusItemId, setFocusItemId] = useState<string | null>(null);
  const [includeMusic, setIncludeMusic] = useState(false);

  // Keep selection valid when project tracks change.
  useEffect(() => {
    if (!track || !trackOptions.some((t) => t.id === track)) {
      setTrack(defaultId);
    }
  }, [track, trackOptions, defaultId]);

  const activeTrack = trackOptions.find((t) => t.id === track) ?? null;
  const busy = status === 'uploading' || status === 'processing';

  const allClips = useMemo(() => (track ? mediaOnTrack(items, track) : []), [items, track]);
  const speechClips = useMemo(() => allClips.filter((c) => !isLikelyNonSpeech(c)), [allClips]);
  const clips = includeMusic ? allClips : (speechClips.length ? speechClips : allClips);
  const skippedMusic = includeMusic ? 0 : allClips.length - clips.length;

  const transcribed = clips.filter((c) => (c.transcript?.length ?? 0) > 0);
  const focusItem =
    (focusItemId && clips.find((c) => c.id === focusItemId))
    || transcribed[0]
    || clips[0]
    || null;

  const editable = !!focusItem?.transcript?.length;
  /** any clip on the track already has words (not only the focused chip) */
  const trackHasWords = transcribed.length > 0;
  const focusDeleted = new Set(focusItem?.deletedWordIdx ?? []);

  // Tracks that actually have media (for selector)
  const selectable = useMemo(
    () => trackOptions.filter((t) => mediaOnTrack(items, t.id).length > 0),
    [trackOptions, items],
  );

  const transcribeTrack = async () => {
    if (!clips.length) return;
    const jobs = clips.map((c) => ({ path: c.src!, itemId: c.id, label: clipLabel(c) }));
    reset();
    try {
      await runMany(jobs, (itemId, r) => {
        onSetItemTranscript(itemId, r.words);
        setFocusItemId(itemId);
      });
    } catch { /* hook holds error */ }
  };

  const applyPause = () => {
    if (!focusItem?.transcript?.length) return;
    const w = focusItem.transcript;
    const { count, savedMs } = analyzeSilences(w, compressSec * 1000);
    const fillers = w.filter((x) => /^[\s]*([uU][hm]+|[eE]r+m?|嗯|呃|啊|唔|额)[\s.,]*$/.test(x.text)).length;
    onCleanScript(focusItem.id, { silenceFrames: Math.round(compressSec * fps), removeFillers });
    setPauseResult(
      `已压缩 ${count} 处长停顿到 ${compressSec}s（约省 ${(savedMs / 1000).toFixed(1)}s）`
      + (removeFillers ? ` · 去填充词 ${fillers}` : ''),
    );
  };

  const generateCaptions = () => {
    const sources = transcribed.map((c) => c.id);
    if (!sources.length) return;
    onSetCaptions({
      enabled: true,
      template: captions?.template ?? 'tiktok',
      pacing: captions?.pacing ?? 'phrase',
      sourceItemId: sources[0] ?? focusItem?.id ?? null,
      sources: sources.length > 1 ? sources : undefined,
      sourceMode: sources.length > 1 ? 'item' : undefined,
    });
  };

  const onTranslate = async (lang: string) => {
    if (!captions || translating) return;
    setTranslating(true);
    setTranslateError(null);
    try {
      const cues = await buildTranslation(captions, items, fps, lang);
      onUpdateCaptions({ bilingual: true, translationLang: lang, translation: cues });
    } catch (e) {
      setTranslateError(e instanceof Error ? e.message : String(e));
    } finally {
      setTranslating(false);
    }
  };

  const aliasLabel = activeTrack ? trackTitle(activeTrack) : '—';

  return (
    <div className="cc-transcript-panel">
      <div className="cc-transcript-toolbar">
        <button type="button" onClick={() => setPauseOpen((v) => !v)} className="cc-tx-btn" disabled={!editable}>
          <Icon name="clock" size={13} />停顿
        </button>
        <select value={view} onChange={(e) => setView(e.target.value as 'paragraph' | 'segment')} className="cc-tx-select">
          <option value="paragraph">段落视图</option>
          <option value="segment">片段视图</option>
        </select>
        <button
          type="button"
          onClick={() => setEditMode((v) => !v)}
          disabled={!editable}
          title={editable ? '点词删除 = 剪掉那段音频' : '先转写该轨音频'}
          className={`cc-tx-btn${editMode ? ' active' : ''}`}
        >
          <Icon name="pencil" size={13} />编辑
        </button>
        <span className="cc-tx-spacer" />
        {pauseOpen && (
          <div className="cc-tx-popover">
            <div className="cc-tx-muted" style={{ marginBottom: 6 }}>停顿时长</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="range" min={0.1} max={2} step={0.05} value={compressSec}
                onChange={(e) => setCompressSec(Number(e.target.value))} style={{ flex: 1, accentColor: '#c45c26' }} />
              <span style={{ fontSize: 12, width: 42, textAlign: 'right' }}>{compressSec.toFixed(2)}s</span>
            </div>
            <label className="cc-tx-check">
              <input type="checkbox" checked={removeFillers} onChange={(e) => setRemoveFillers(e.target.checked)} />
              去掉填充词（嗯 / 呃 / um…）
            </label>
            {pauseResult && <div style={{ fontSize: 11, marginBottom: 8 }}>{pauseResult}</div>}
            <button type="button" onClick={applyPause} disabled={!hasWords} className="cc-tx-btn primary block">应用</button>
          </div>
        )}
      </div>

      {/* Track chips — alias · name, never bare UUID */}
      <div className="cc-tx-tracks" role="tablist" aria-label="转写轨道">
        {selectable.length === 0 ? (
          <span className="cc-tx-muted">时间线上还没有可转写的音视频轨</span>
        ) : (
          selectable.map((t) => {
            const n = mediaOnTrack(items, t.id).length;
            const speechN = mediaOnTrack(items, t.id).filter((c) => !isLikelyNonSpeech(c)).length;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={track === t.id}
                className={`cc-tx-track-chip${track === t.id ? ' selected' : ''}`}
                onClick={() => { setTrack(t.id); setFocusItemId(null); setPauseResult(null); }}
                title={t.id}
              >
                <span className="cc-tx-track-alias">{t.alias}</span>
                {t.name ? <span className="cc-tx-track-name">{t.name}</span> : null}
                <span className="cc-tx-track-count">{speechN || n}</span>
              </button>
            );
          })
        )}
      </div>

      {editMode && editable && focusItem && (
        <div className="cc-tx-editbar">
          <span>点词删除/恢复（当前段）。已删 <b>{focusDeleted.size}</b> 词</span>
          {focusDeleted.size > 0 && (
            <button type="button" onClick={() => onClearEdits(focusItem.id)} className="cc-tx-btn sm">还原全部</button>
          )}
        </div>
      )}

      <div className="cc-tx-body">
        {!track || selectable.length === 0 ? (
          <div className="cc-tx-empty-card">
            <div className="cc-tx-empty-icon" aria-hidden><Icon name="mic" size={22} /></div>
            <div className="cc-tx-empty-title">还没有可转写的轨道</div>
            <p className="cc-tx-muted">把口播/配音或带人声的视频加到时间线后，再打开文字稿。</p>
          </div>
        ) : !trackHasWords ? (
          <div className="cc-tx-empty-card">
            <div className="cc-tx-empty-kicker">{aliasLabel}</div>
            <div className="cc-tx-empty-title">转写词级文字稿</div>
            <p className="cc-tx-muted">
              中文词级转写 · 说话人分离 · 该轨共 {clips.length} 段会逐段上传。转写后可点词删减（删词=剪音频）。
            </p>
            {skippedMusic > 0 && (
              <label className="cc-tx-check music">
                <input type="checkbox" checked={includeMusic} onChange={(e) => setIncludeMusic(e.target.checked)} />
                包含疑似背景音乐（已跳过 {skippedMusic} 段）
              </label>
            )}
            <ul className="cc-tx-cliplist">
              {clips.map((c) => (
                <li key={c.id}>
                  <Icon name={c.kind === 'video' ? 'video' : 'volume'} size={13} />
                  <span className="cc-tx-clipname">{clipLabel(c)}</span>
                  <span className="cc-tx-clipdur">{(c.durationInFrames / fps).toFixed(1)}s</span>
                </li>
              ))}
            </ul>
            {!clips.length ? (
              <p className="cc-tx-muted">
                该轨只有背景音乐类素材。打开「包含疑似背景音乐」或换到配音轨。
              </p>
            ) : (
              <button type="button" onClick={() => void transcribeTrack()} disabled={busy} className="cc-tx-btn primary lg">
                {busy ? (progressNote ?? '转写中…') : `转写 ${activeTrack?.alias ?? ''}（${clips.length} 段）`}
              </button>
            )}
            {status === 'error' && <div className="cc-tx-error">{error}</div>}
          </div>
        ) : (
          <>
            {clips.length > 1 && (
              <div className="cc-tx-clip-tabs">
                {clips.map((c) => {
                  const n = c.transcript?.length ?? 0;
                  const done = n > 0;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className={`cc-tx-clip-tab${focusItem?.id === c.id ? ' selected' : ''}${done ? '' : ' pending'}`}
                      onClick={() => {
                        setFocusItemId(c.id);
                        document.getElementById(`cc-tx-sec-${c.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                      }}
                    >
                      {clipLabel(c)}
                      {done ? ` · ${n}词` : ' · 未转写'}
                    </button>
                  );
                })}
                <button type="button" className="cc-tx-btn sm" disabled={busy} onClick={() => void transcribeTrack()}>
                  {busy ? '…' : '重新转写'}
                </button>
              </div>
            )}
            {/* Full track: every clip as a section — not just the focused chip (was the "only one" illusion). */}
            <div className="cc-tx-sections">
              {clips.map((c) => {
                const cWords = c.transcript ?? [];
                const cDel = new Set(c.deletedWordIdx ?? []);
                const cGroups = view === 'paragraph' ? toParagraphs(cWords) : toSegments(cWords);
                const active = focusItem?.id === c.id;
                return (
                  <section
                    key={c.id}
                    id={`cc-tx-sec-${c.id}`}
                    className={`cc-tx-section${active ? ' active' : ''}`}
                    onClick={() => setFocusItemId(c.id)}
                  >
                    <header className="cc-tx-section-head">
                      <span className="cc-tx-section-title">{clipLabel(c)}</span>
                      <span className="cc-tx-muted">
                        {(c.durationInFrames / fps).toFixed(1)}s
                        {cWords.length ? ` · ${cWords.length} 词` : ' · 未转写'}
                      </span>
                    </header>
                    {!cWords.length ? (
                      <div className="cc-tx-muted" style={{ padding: '4px 0 8px' }}>尚未转写此段</div>
                    ) : view === 'paragraph' ? (
                      <ParagraphView
                        groups={cGroups}
                        deleted={cDel}
                        editMode={editMode && active}
                        onWord={(w) => {
                          setFocusItemId(c.id);
                          if (editMode) onToggleWord(c.id, w.gi);
                          else playerRef.current?.seekTo(c.startFrame + msToFrame(w.start, fps));
                        }}
                      />
                    ) : (
                      <SegmentView
                        groups={cGroups}
                        deleted={cDel}
                        editMode={editMode && active}
                        fps={fps}
                        onWord={(w) => {
                          setFocusItemId(c.id);
                          if (editMode) onToggleWord(c.id, w.gi);
                          else playerRef.current?.seekTo(c.startFrame + msToFrame(w.start, fps));
                        }}
                      />
                    )}
                  </section>
                );
              })}
            </div>
            {(status === 'error' || error) && <div className="cc-tx-error">{error}</div>}
            {busy && progressNote && <div className="cc-tx-muted" style={{ marginTop: 8 }}>{progressNote}</div>}
            {!busy && trackHasWords && (
              <div className="cc-tx-muted" style={{ marginTop: 10 }}>
                已转写 {transcribed.length}/{clips.length} 段
                {transcribed.length < clips.length ? ' · 可点「重新转写」补全失败段' : ''}
              </div>
            )}
          </>
        )}
      </div>

      <CaptionsControls
        captions={captions}
        hasTranscript={trackHasWords}
        onGenerate={generateCaptions}
        onUpdate={onUpdateCaptions}
        onTranslate={onTranslate}
        translating={translating}
        translateError={translateError}
      />
    </div>
  );
}
