import { useMemo, useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import { theme } from '../theme';
import type { TimelineItem, TrackId } from '../editor/types';
import { useTranscript } from '../transcript/useTranscript';
import { msToFrame, type TranscriptWord } from '../transcript/types';
import { toParagraphs, toSegments, analyzeSilences, type IndexedWord } from '../transcript/segment';
import { ParagraphView, SegmentView } from './TranscriptViews';
import { CaptionsControls } from './CaptionsControls';
import type { CaptionsData } from '../captions/types';
import { buildTranslation } from '../captions/translate';
import { Icon } from './icons';

interface TranscriptPanelProps {
  playerRef: RefObject<PlayerRef | null>;
  fps: number;
  items: TimelineItem[];
  captions: CaptionsData | null;
  onSetCaptions: (c: CaptionsData | null) => void;
  onUpdateCaptions: (patch: Partial<CaptionsData>) => void;
  onSetItemTranscript: (id: string, words: TranscriptWord[]) => void;
  onToggleWord: (id: string, idx: number) => void;
  onCleanScript: (id: string, opts: { silenceFrames?: number; removeFillers: boolean }) => void;
  onClearEdits: (id: string) => void;
}

/** Clips that can carry spoken audio (audio track or video with soundtrack). */
function mediaOnTrack(items: TimelineItem[], track: TrackId): TimelineItem[] {
  return items
    .filter((it) => it.track === track && !!it.src && (it.kind === 'audio' || it.kind === 'video'))
    .sort((a, b) => a.startFrame - b.startFrame);
}

function clipLabel(it: TimelineItem): string {
  const n = it.name?.trim() || it.id;
  return n.length > 28 ? `${n.slice(0, 26)}…` : n;
}

// 文字稿: 轨选择 + 转写真实时间线音频(多片段) + 段落/片段视图 + 字幕.
// 根因修复: 绝不静默回退到 /media/speech-sample.mp3 (英文 demo → 驴唇不对马嘴).
export function TranscriptPanel({
  playerRef, fps, items, captions, onSetCaptions, onUpdateCaptions,
  onSetItemTranscript, onToggleWord, onCleanScript, onClearEdits,
}: TranscriptPanelProps) {
  const { status, error, progressNote, runMany, reset } = useTranscript();
  const tracks = useMemo(() => {
    const ids = new Set<TrackId>();
    for (const it of items) {
      if (it.src && (it.kind === 'audio' || it.kind === 'video')) ids.add(it.track);
    }
    // Always offer common tracks so empty projects still show controls.
    for (const t of ['A1', 'A2', 'V1', 'V2'] as TrackId[]) ids.add(t);
    return [...ids];
  }, [items]);

  const [track, setTrack] = useState<TrackId>('A1');
  const [view, setView] = useState<'paragraph' | 'segment'>('paragraph');
  const [editMode, setEditMode] = useState(false);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [compressSec, setCompressSec] = useState(0.5);
  const [removeFillers, setRemoveFillers] = useState(true);
  const [pauseResult, setPauseResult] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  const [translateError, setTranslateError] = useState<string | null>(null);
  /** which clip's transcript is focused when multiple exist on the track */
  const [focusItemId, setFocusItemId] = useState<string | null>(null);

  const busy = status === 'uploading' || status === 'processing';
  const clips = useMemo(() => mediaOnTrack(items, track), [items, track]);
  const transcribed = clips.filter((c) => (c.transcript?.length ?? 0) > 0);
  const focusItem =
    (focusItemId && clips.find((c) => c.id === focusItemId))
    || transcribed[0]
    || clips[0]
    || null;

  const words = focusItem?.transcript ?? [];
  const deleted = new Set(focusItem?.deletedWordIdx ?? []);
  const editable = !!focusItem?.transcript?.length;
  const hasWords = words.length > 0;

  const onWord = (w: IndexedWord) => {
    if (!focusItem) return;
    if (editMode && editable) onToggleWord(focusItem.id, w.gi);
    else {
      // word times are source-relative ms; map to timeline frame via clip start
      const local = msToFrame(w.start, fps);
      playerRef.current?.seekTo(focusItem.startFrame + local);
    }
  };

  const transcribeTrack = async () => {
    if (!clips.length) return;
    // Re-transcribe all clips on track (needed after wrong sample attach).
    const jobs = clips.map((c) => ({
      path: c.src!,
      itemId: c.id,
      label: clipLabel(c),
    }));
    reset();
    try {
      await runMany(jobs, (itemId, r) => {
        onSetItemTranscript(itemId, r.words);
        setFocusItemId(itemId);
      });
    } catch {
      /* error already in hook state */
    }
  };

  const applyPause = () => {
    if (!hasWords || !focusItem) return;
    const { count, savedMs } = analyzeSilences(words, compressSec * 1000);
    const fillers = words.filter((w) => /^[\s]*([uU][hm]+|[eE]r+m?|嗯|呃|啊|唔|额)[\s.,]*$/.test(w.text)).length;
    onCleanScript(focusItem.id, { silenceFrames: Math.round(compressSec * fps), removeFillers });
    setPauseResult(
      `已压缩 ${count} 处长停顿到 ${compressSec}s（约省 ${(savedMs / 1000).toFixed(1)}s）`
      + (removeFillers ? ` · 去填充词 ${fillers}` : ''),
    );
  };

  const generateCaptions = () => {
    // Prefer all transcribed clips on this track as caption sources.
    const sources = transcribed.map((c) => c.id);
    if (!sources.length && !hasWords) return;
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

  const groups = view === 'paragraph' ? toParagraphs(words) : toSegments(words);

  return (
    <div className="cc-transcript-panel">
      <div className="cc-transcript-toolbar">
        <button type="button" onClick={() => setPauseOpen((v) => !v)} className="cc-tx-btn" disabled={!hasWords}>
          <Icon name="clock" size={13} />停顿
        </button>
        <select
          value={view}
          onChange={(e) => setView(e.target.value as 'paragraph' | 'segment')}
          className="cc-tx-select"
        >
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
        <select
          value={track}
          onChange={(e) => {
            setTrack(e.target.value as TrackId);
            setFocusItemId(null);
            setPauseResult(null);
          }}
          className="cc-tx-select"
          title="选择要转写/编辑的轨道"
        >
          {tracks.map((t) => {
            const n = mediaOnTrack(items, t).length;
            return (
              <option key={t} value={t}>
                {t}{n ? ` · ${n} 段` : ''}
              </option>
            );
          })}
        </select>
        {pauseOpen && (
          <div className="cc-tx-popover">
            <div className="cc-tx-muted" style={{ marginBottom: 6 }}>停顿时长</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="range" min={0.1} max={2} step={0.05} value={compressSec}
                onChange={(e) => setCompressSec(Number(e.target.value))}
                style={{ flex: 1, accentColor: theme.accent }}
              />
              <span style={{ fontSize: 12, width: 42, textAlign: 'right' }}>{compressSec.toFixed(2)}s</span>
            </div>
            <div className="cc-tx-muted" style={{ margin: '6px 0 8px', lineHeight: 1.5 }}>
              较长停顿压缩到该长度；较短停顿保留。
            </div>
            <label className="cc-tx-check">
              <input type="checkbox" checked={removeFillers} onChange={(e) => setRemoveFillers(e.target.checked)} />
              去掉填充词（嗯 / 呃 / um / uh…）
            </label>
            {pauseResult && <div style={{ fontSize: 11, color: theme.text, marginBottom: 8 }}>{pauseResult}</div>}
            <button type="button" onClick={applyPause} disabled={!hasWords} className="cc-tx-btn primary block">
              应用（压缩静音）
            </button>
          </div>
        )}
      </div>

      {editMode && editable && focusItem && (
        <div className="cc-tx-editbar">
          <span>点词删除/恢复（删词 = 剪掉那段音视频）。已删 <b>{deleted.size}</b> 词</span>
          {deleted.size > 0 && (
            <button type="button" onClick={() => onClearEdits(focusItem.id)} className="cc-tx-btn sm">还原全部</button>
          )}
        </div>
      )}

      <div className="cc-tx-body">
        {clips.length === 0 ? (
          <div className="cc-tx-empty">
            <div className="cc-tx-empty-title">{track} 轨上没有可转写的音频/视频</div>
            <p className="cc-tx-muted">
              把口播、配音或带人声的视频加到时间线后，再点「转写」。
              不会再静默使用示例英文语音。
            </p>
          </div>
        ) : !hasWords ? (
          <div className="cc-tx-empty">
            <button
              type="button"
              onClick={() => void transcribeTrack()}
              disabled={busy}
              className="cc-tx-btn primary"
            >
              {busy ? (progressNote ?? '转写中…') : `转写 ${track}（${clips.length} 段）`}
            </button>
            <p className="cc-tx-muted" style={{ marginTop: 10, lineHeight: 1.55 }}>
              将依次转写该轨全部媒体片段（词级 + 说话人分离，自动语种检测）。
            </p>
            <ul className="cc-tx-cliplist">
              {clips.map((c) => (
                <li key={c.id}>
                  <span className="cc-tx-clipname">{clipLabel(c)}</span>
                  <span className="cc-tx-muted">{(c.durationInFrames / fps).toFixed(1)}s</span>
                </li>
              ))}
            </ul>
            {status === 'error' && <div className="cc-tx-error">{error}</div>}
          </div>
        ) : (
          <>
            {clips.length > 1 && (
              <div className="cc-tx-clip-tabs">
                {clips.map((c) => {
                  const done = (c.transcript?.length ?? 0) > 0;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className={`cc-tx-clip-tab${focusItem?.id === c.id ? ' selected' : ''}${done ? '' : ' pending'}`}
                      onClick={() => setFocusItemId(c.id)}
                      title={c.name}
                    >
                      {clipLabel(c)}
                      {!done && ' · 未转写'}
                    </button>
                  );
                })}
                <button
                  type="button"
                  className="cc-tx-btn sm"
                  disabled={busy}
                  onClick={() => void transcribeTrack()}
                  title="重新转写该轨全部片段"
                >
                  {busy ? '…' : '重新转写'}
                </button>
              </div>
            )}
            {view === 'paragraph' ? (
              <ParagraphView groups={groups} deleted={deleted} editMode={editMode && editable} onWord={onWord} />
            ) : (
              <SegmentView groups={groups} deleted={deleted} editMode={editMode && editable} onWord={onWord} fps={fps} />
            )}
            {status === 'error' && <div className="cc-tx-error">{error}</div>}
            {busy && progressNote && <div className="cc-tx-muted" style={{ marginTop: 8 }}>{progressNote}</div>}
          </>
        )}
      </div>

      <CaptionsControls
        captions={captions}
        hasTranscript={transcribed.length > 0 || hasWords}
        onGenerate={generateCaptions}
        onUpdate={onUpdateCaptions}
        onTranslate={onTranslate}
        translating={translating}
        translateError={translateError}
      />
    </div>
  );
}
