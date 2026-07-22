import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { TimelineItem, TrackId } from '../editor/types';
import { emitSelectionRef, transcriptRefFromDomSelection, useSelectionRefMode } from '../agent/selection-refs';
import { useTranscript } from './useTranscript';
import { msToFrame, type TranscriptWord } from './types';
import { analyzeSilences } from './segment';
import { ScriptView } from './TranscriptViews';
import { theme } from '../theme';
import { Icon } from '../components/icons';
import { useT } from '../i18n/locale';
import { clipLabel, isLikelyNonSpeech, mediaOnTrack, pickDefaultTrack, trackTitle, type TranscriptTrackOption } from './trackOptions';

export type { TranscriptTrackOption } from './trackOptions';

interface TranscriptPanelProps {
  playerRef: RefObject<PlayerRef | null>;
  fps: number;
  items: TimelineItem[];
  /** ordered tracks with A1/V1 aliases from EditorCore */
  trackOptions: TranscriptTrackOption[];
  onSetItemTranscript: (id: string, words: TranscriptWord[]) => void;
  onToggleWord: (id: string, idx: number) => void;
  onCleanScript: (id: string, opts: { silenceFrames?: number; removeFillers: boolean }) => void;
  onSetGapCap: (id: string, afterWordIndex: number, maxMs: number | null) => void;
  onSetTranscriptPlayOrder: (id: string, playOrder: number[] | null) => void;
  onReorderTrackItems: (track: TrackId, orderedIds: string[]) => void;
  onClearEdits: (id: string) => void;
  onOpenCaptionStyles?: (sourceItemIds: string[]) => void;
}

const MANY_CLIPS = 10;

export function TranscriptPanel({
  playerRef, fps, items, trackOptions,
  onSetItemTranscript, onToggleWord, onCleanScript, onSetGapCap, onSetTranscriptPlayOrder, onReorderTrackItems, onClearEdits,
  onOpenCaptionStyles,
}: TranscriptPanelProps) {
  const t = useT();
  const { status, error, progressNote, runMany, reset } = useTranscript();
  const defaultId = useMemo(() => pickDefaultTrack(trackOptions, items), [trackOptions, items]);
  const [track, setTrack] = useState<TrackId | null>(defaultId);
  // Both views use ScriptView (speaker blocks + Gap rows). segment uses a lower
  // gap display threshold so more breaths show; paragraph is slightly coarser.
  const [view, setView] = useState<'paragraph' | 'segment'>('segment');
  const [editMode, setEditMode] = useState(false);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [compressSec, setCompressSec] = useState(0.5);
  const [removeFillers, setRemoveFillers] = useState(true);
  const [pauseResult, setPauseResult] = useState<string | null>(null);
  const [focusItemId, setFocusItemId] = useState<string | null>(null);
  const [includeMusic, setIncludeMusic] = useState(false);
  /** many clips: default show only the focused section to keep the list usable */
  const [showAllSections, setShowAllSections] = useState(false);
  const dragClipFrom = useRef<string | null>(null);
  const [dragOverClipId, setDragOverClipId] = useState<string | null>(null);
  // 选择模式 (transcript-selected): drag-select words → structured reference
  const pickMode = useSelectionRefMode();
  const bodyRef = useRef<HTMLDivElement>(null);

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

  const jumpToClip = (id: string) => {
    setFocusItemId(id);
    // when only showing current section, still try scroll after paint
    requestAnimationFrame(() => {
      document.getElementById(`cc-tx-sec-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  };

  const focusIndex = focusItem ? clips.findIndex((c) => c.id === focusItem.id) : -1;

  // Selection mode: a native text selection over the word spans becomes a
  // transcript-selection reference (词 id / 文本 / 源媒体 ms + keptSegments 帧映射).
  const pickFromDomSelection = () => {
    if (!pickMode || !bodyRef.current) return;
    const reference = transcriptRefFromDomSelection(bodyRef.current, clips, fps);
    if (reference) emitSelectionRef(reference);
  };

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

  const sectionsToShow = useMemo(() => {
    if (showAllSections || clips.length <= MANY_CLIPS) return clips;
    // dense mode: only the focused clip (fallback first)
    const cur = focusItem ?? clips[0];
    return cur ? [cur] : clips;
  }, [clips, showAllSections, focusItem]);

  const applyPause = () => {
    if (!focusItem?.transcript?.length) return;
    const w = focusItem.transcript;
    const { count, savedMs } = analyzeSilences(w, compressSec * 1000);
    const fillers = w.filter((x) => /^[\s]*([uU][hm]+|[eE]r+m?|嗯|呃|啊|唔|额)[\s.,]*$/.test(x.text)).length;
    onCleanScript(focusItem.id, { silenceFrames: Math.round(compressSec * fps), removeFillers });
    setPauseResult(
      t('已压缩 {count} 处长停顿到 {sec}s（约省 {saved}s）', { count, sec: compressSec, saved: (savedMs / 1000).toFixed(1) })
      + (removeFillers ? t(' · 去填充词 {n}', { n: fillers }) : ''),
    );
  };

  const aliasLabel = activeTrack ? trackTitle(activeTrack) : '—';

  return (
    <div className="cc-transcript-panel">
      <div className="cc-transcript-toolbar">
        <button type="button" onClick={() => setPauseOpen((v) => !v)} className="cc-tx-btn" disabled={!editable}>
          <Icon name="clock" size={13} />{t('停顿')}
        </button>
        <select value={view} onChange={(e) => setView(e.target.value as 'paragraph' | 'segment')} className="cc-tx-select">
          <option value="paragraph">{t('段落视图')}</option>
          <option value="segment">{t('片段视图')}</option>
        </select>
        <button
          type="button"
          onClick={() => setEditMode((v) => !v)}
          disabled={!editable}
          title={editable ? t('点词删除 = 剪掉那段音频') : t('先转写该轨音频')}
          className={`cc-tx-btn${editMode ? ' active' : ''}`}
        >
          <Icon name="pencil" size={13} />{t('编辑')}
        </button>
        <button
          type="button"
          className="cc-tx-btn"
          disabled={!onOpenCaptionStyles}
          title={onOpenCaptionStyles ? t('字幕样式') : t('请先新建字幕轨道')}
          onClick={() => onOpenCaptionStyles?.(transcribed.map((item) => item.id))}
        >
          <Icon name="captions" size={13} />{t('字幕样式')}
        </button>
        <span className="cc-tx-spacer" />
        {pauseOpen && (
          <div className="cc-tx-popover">
            <div className="cc-tx-muted" style={{ marginBottom: 6 }}>{t('停顿时长')}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="range" min={0.1} max={2} step={0.05} value={compressSec}
                onChange={(e) => setCompressSec(Number(e.target.value))} style={{ flex: 1, accentColor: theme.accentDeep }} />
              <span style={{ fontSize: 12, width: 42, textAlign: 'right' }}>{compressSec.toFixed(2)}s</span>
            </div>
            <label className="cc-tx-check">
              <input type="checkbox" checked={removeFillers} onChange={(e) => setRemoveFillers(e.target.checked)} />
              {t('去掉填充词（嗯 / 呃 / um…）')}
            </label>
            {pauseResult && <div style={{ fontSize: 11, marginBottom: 8 }}>{pauseResult}</div>}
            <button type="button" onClick={applyPause} disabled={!editable} className="cc-tx-btn primary block">{t('应用')}</button>
          </div>
        )}
      </div>

      {/* Track chips — alias · name, never bare UUID */}
      <div className="cc-tx-tracks" role="tablist" aria-label={t('转写轨道')}>
        {selectable.length === 0 ? (
          <span className="cc-tx-muted">{t('时间线上还没有可转写的音视频轨')}</span>
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
          <span>{t('点词删除/恢复（当前段）。已删')} <b>{focusDeleted.size}</b> {t('词')}</span>
          {focusDeleted.size > 0 && (
            <button type="button" onClick={() => onClearEdits(focusItem.id)} className="cc-tx-btn sm">{t('还原全部')}</button>
          )}
        </div>
      )}

      {pickMode && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 12px', fontSize: 11, color: theme.accent, flexShrink: 0 }}>
          {t('选择模式：拖选一段词句作为引用（松开即添加到聊天）')}
        </div>
      )}
      <div className="cc-tx-body" ref={bodyRef} onMouseUp={pickFromDomSelection} style={pickMode ? { cursor: 'text' } : undefined}>
        {!track || selectable.length === 0 ? (
          <div className="cc-tx-empty-card blank">
            <div className="cc-tx-empty-icon" aria-hidden><Icon name="mic" size={14} /></div>
            <div className="cc-tx-empty-title">{t('还没有可转写的轨道')}</div>
            <p className="cc-tx-muted">{t('把口播 / 配音或带人声的视频加到时间线后，再打开文字稿。')}</p>
          </div>
        ) : !trackHasWords ? (
          <div className="cc-tx-empty-card">
            <div className="cc-tx-empty-kicker">{aliasLabel}</div>
            <div className="cc-tx-empty-title">{t('转写词级文字稿')}</div>
            <p className="cc-tx-muted">
              {t('中文词级转写 · 说话人分离 · 该轨共 {n} 段会逐段上传。转写后可点词删减（删词=剪音频）。', { n: clips.length })}
            </p>
            {skippedMusic > 0 && (
              <label className="cc-tx-check music">
                <input type="checkbox" checked={includeMusic} onChange={(e) => setIncludeMusic(e.target.checked)} />
                {t('包含疑似背景音乐（已跳过 {n} 段）', { n: skippedMusic })}
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
                {t('该轨只有背景音乐类素材。打开「包含疑似背景音乐」或换到配音轨。')}
              </p>
            ) : (
              <button type="button" onClick={() => void transcribeTrack()} disabled={busy} className="cc-tx-btn primary lg">
                {busy ? (progressNote ?? t('转写中…')) : t('转写 {alias}（{n} 段）', { alias: activeTrack?.alias ?? '', n: clips.length })}
              </button>
            )}
            {status === 'error' && <div className="cc-tx-error">{error}</div>}
          </div>
        ) : (
          <>
            {clips.length > 1 && (
              <div className="cc-tx-nav">
                <div className="cc-tx-nav-bar">
                  <select
                    className="cc-tx-nav-select"
                    value={focusItem?.id ?? clips[0]?.id ?? ''}
                    onChange={(e) => jumpToClip(e.target.value)}
                    title={t('跳转到片段')}
                    aria-label={t('跳转到片段')}
                  >
                    {clips.map((c, i) => {
                      const n = c.transcript?.length ?? 0;
                      return (
                        <option key={c.id} value={c.id}>
                          {i + 1}/{clips.length} · {clipLabel(c, 40)}{n ? t(' · {n}词', { n }) : t(' · 未转写')}
                        </option>
                      );
                    })}
                  </select>
                  <div className="cc-tx-nav-step">
                    <button
                      type="button"
                      className="cc-tx-btn sm"
                      disabled={focusIndex <= 0}
                      onClick={() => focusIndex > 0 && jumpToClip(clips[focusIndex - 1]!.id)}
                      title={t('上一段')}
                    >
                      ‹
                    </button>
                    <span className="cc-tx-nav-count">
                      {Math.max(1, focusIndex + 1)}/{clips.length}
                    </span>
                    <button
                      type="button"
                      className="cc-tx-btn sm"
                      disabled={focusIndex < 0 || focusIndex >= clips.length - 1}
                      onClick={() => focusIndex >= 0 && focusIndex < clips.length - 1 && jumpToClip(clips[focusIndex + 1]!.id)}
                      title={t('下一段')}
                    >
                      ›
                    </button>
                  </div>
                  <button type="button" className="cc-tx-btn sm" disabled={busy} onClick={() => void transcribeTrack()}>
                    {busy ? '…' : t('重新转写')}
                  </button>
                </div>
                {clips.length > MANY_CLIPS && (
                  <label className="cc-tx-nav-mode">
                    <input
                      type="checkbox"
                      checked={showAllSections}
                      onChange={(e) => setShowAllSections(e.target.checked)}
                    />
                    {t('列出全部 {n} 段正文（默认只看当前段，避免列表过长）', { n: clips.length })}
                  </label>
                )}
              </div>
            )}
            <div className="cc-tx-sections">
              {sectionsToShow.map((c) => {
                const cWords = c.transcript ?? [];
                const cDel = new Set(c.deletedWordIdx ?? []);
                const active = focusItem?.id === c.id;
                const idx = clips.findIndex((x) => x.id === c.id);
                const minDisplayMs = view === 'paragraph' ? 400 : 250;
                const canDragClip = clips.length > 1 && !!track;
                return (
                  <section
                    key={c.id}
                    id={`cc-tx-sec-${c.id}`}
                    className={`cc-tx-section${active ? ' active' : ''}${dragOverClipId === c.id ? ' drag-over' : ''}`}
                    draggable={canDragClip}
                    onClick={() => setFocusItemId(c.id)}
                    onDragStart={(e) => {
                      if (!canDragClip) return;
                      dragClipFrom.current = c.id;
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', `clip:${c.id}`);
                    }}
                    onDragEnd={() => {
                      dragClipFrom.current = null;
                      setDragOverClipId(null);
                    }}
                    onDragOver={(e) => {
                      if (!canDragClip || !dragClipFrom.current || dragClipFrom.current === c.id) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      setDragOverClipId(c.id);
                    }}
                    onDragLeave={() => setDragOverClipId((id) => (id === c.id ? null : id))}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const fromId = dragClipFrom.current;
                      dragClipFrom.current = null;
                      setDragOverClipId(null);
                      if (!fromId || !track || fromId === c.id) return;
                      const ids = clips.map((x) => x.id);
                      const from = ids.indexOf(fromId);
                      const to = ids.indexOf(c.id);
                      if (from < 0 || to < 0) return;
                      const next = [...ids];
                      const [moved] = next.splice(from, 1);
                      if (!moved) return;
                      next.splice(to, 0, moved);
                      onReorderTrackItems(track, next);
                      setFocusItemId(fromId);
                    }}
                  >
                    <header className="cc-tx-section-head">
                      <span
                        className={`cc-tx-section-grip${canDragClip ? ' active' : ''}`}
                        title={canDragClip ? t('拖动卡片以重排时间线该轨片段顺序') : undefined}
                      >
                        ⋮⋮
                      </span>
                      <span className="cc-tx-section-title">
                        {clips.length > 1 ? `${idx + 1}. ` : ''}{clipLabel(c, 36)}
                      </span>
                      <span className="cc-tx-muted">
                        {(c.durationInFrames / fps).toFixed(1)}s
                        {cWords.length ? t(' · {n} 词', { n: cWords.length }) : t(' · 未转写')}
                        {c.transcriptPlayOrder?.length ? t(' · 已重排语段') : ''}
                      </span>
                    </header>
                    {!cWords.length ? (
                      <div className="cc-tx-muted" style={{ padding: '4px 0 8px' }}>{t('尚未转写此段')}</div>
                    ) : (
                      <ScriptView
                        words={cWords}
                        deleted={cDel}
                        editMode={editMode && active}
                        fps={fps}
                        gapCapsMs={c.gapCapsMs}
                        silenceFrames={c.silenceFrames}
                        playOrder={c.transcriptPlayOrder}
                        minDisplayMs={minDisplayMs}
                        onWord={(w) => {
                          if (pickMode) return; // selection mode: words are for drag-select, not seek/delete
                          setFocusItemId(c.id);
                          if (editMode) onToggleWord(c.id, w.gi);
                          else playerRef.current?.seekTo(c.startFrame + msToFrame(w.start, fps));
                        }}
                        onDeleteGap={(afterGi) => {
                          setFocusItemId(c.id);
                          onSetGapCap(c.id, afterGi, 0);
                        }}
                        onCapGap={(afterGi, maxMs) => {
                          setFocusItemId(c.id);
                          onSetGapCap(c.id, afterGi, maxMs);
                        }}
                        onReorderSpeech={(order) => {
                          setFocusItemId(c.id);
                          onSetTranscriptPlayOrder(c.id, order);
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
                {t('已转写 {done}/{total} 段', { done: transcribed.length, total: clips.length })}
                {transcribed.length < clips.length ? t(' · 可点「重新转写」补全失败段') : ''}
                {clips.length > MANY_CLIPS && !showAllSections ? t(' · 正文仅显示当前段') : ''}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
