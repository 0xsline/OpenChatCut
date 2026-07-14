import { useEffect, useRef, useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import { theme } from '../theme';
import type { TimelineItem, TrackId } from '../editor/types';
import { useTranscript } from '../transcript/useTranscript';
import { msToFrame, type TranscriptResult, type TranscriptWord } from '../transcript/types';
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

const TRACKS: TrackId[] = ['V1', 'V2', 'A1', 'A2'];
const SAMPLE = '/media/speech-sample.mp3';

// 文字稿:轨道选择 + 说话人分段 + 段落/片段视图 + 停顿 + 转写即编辑(删词=删视频)。
export function TranscriptPanel({ playerRef, fps, items, captions, onSetCaptions, onUpdateCaptions, onSetItemTranscript, onToggleWord, onCleanScript, onClearEdits }: TranscriptPanelProps) {
  const { status, result, error, run } = useTranscript();
  const [track, setTrack] = useState<TrackId>('A1');
  const [view, setView] = useState<'paragraph' | 'segment'>('paragraph');
  const [editMode, setEditMode] = useState(false);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [compressSec, setCompressSec] = useState(0.5);
  const [removeFillers, setRemoveFillers] = useState(true);
  const [pauseResult, setPauseResult] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  const [translateError, setTranslateError] = useState<string | null>(null);
  const busy = status === 'uploading' || status === 'processing';

  const audioItem = items.find((it) => it.kind === 'audio' && it.track === track && it.src);
  const sourcePath = audioItem?.src ?? SAMPLE;
  const sourceLabel = audioItem ? audioItem.name : '示例语音（该轨无音频,删词编辑需先把语音加到该轨）';

  // once transcription finishes, attach the words to the track's audio clip so
  // deletions can re-time the video.
  const attached = useRef<TranscriptResult | null>(null);
  useEffect(() => {
    if (result && audioItem?.id && result !== attached.current) {
      attached.current = result;
      onSetItemTranscript(audioItem.id, result.words);
    }
  }, [result, audioItem?.id, onSetItemTranscript]);

  const words = audioItem?.transcript ?? result?.words ?? [];
  const deleted = new Set(audioItem?.deletedWordIdx ?? []);
  const editable = !!audioItem?.transcript;
  const hasWords = words.length > 0;

  const onWord = (w: IndexedWord) => {
    if (editMode && editable) onToggleWord(audioItem!.id, w.gi);
    else playerRef.current?.seekTo(msToFrame(w.start, fps));
  };
  const applyPause = () => {
    if (!hasWords) return;
    const { count, savedMs } = analyzeSilences(words, compressSec * 1000);
    const fillers = words.filter((w) => /^[\s]*([uU][hm]+|[eE]r+m?|嗯|呃|啊|唔|额)[\s.,]*$/.test(w.text)).length;
    if (editable && audioItem) {
      onCleanScript(audioItem.id, { silenceFrames: Math.round(compressSec * fps), removeFillers });
      setPauseResult(`已压缩 ${count} 处长停顿到 ${compressSec}s（约省 ${(savedMs / 1000).toFixed(1)}s）${removeFillers ? ` · 去填充词 ${fillers}` : ''}`);
    } else {
      setPauseResult(`> ${compressSec}s 的停顿 ${count} 处 → 压缩后约省 ${(savedMs / 1000).toFixed(1)}s（先把语音加到该轨才能真压缩）`);
    }
  };
  const generateCaptions = () => {
    if (!hasWords) return;
    onSetCaptions({
      enabled: true, template: captions?.template ?? 'tiktok', pacing: captions?.pacing ?? 'phrase',
      sourceItemId: audioItem?.id ?? null,
      words: audioItem ? undefined : words,
      offsetFrames: audioItem ? undefined : 0,
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
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      {/* toolbar */}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: `1px solid ${theme.border}`, fontSize: 12, flexWrap: 'wrap' }}>
        <button onClick={() => setPauseOpen((v) => !v)} style={toolBtn}><Icon name="clock" size={13} />停顿</button>
        <select value={view} onChange={(e) => setView(e.target.value as 'paragraph' | 'segment')} style={selectStyle}>
          <option value="paragraph">段落视图</option>
          <option value="segment">片段视图</option>
        </select>
        <button onClick={() => setEditMode((v) => !v)} disabled={!editable} title={editable ? '' : '先转写该轨音频'}
          style={{ ...toolBtn, background: editMode ? theme.accent : theme.panelAlt, color: editMode ? '#fff' : theme.text, opacity: editable ? 1 : 0.45 }}><Icon name="pencil" size={13} />编辑</button>
        <span style={{ flex: 1 }} />
        <select value={track} onChange={(e) => setTrack(e.target.value as TrackId)} style={selectStyle}>
          {TRACKS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {pauseOpen && (
          <div style={popover}>
            <div style={{ fontSize: 11, color: theme.textDim, marginBottom: 6 }}>停顿时长</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="range" min={0.1} max={2} step={0.05} value={compressSec} onChange={(e) => setCompressSec(Number(e.target.value))} style={{ flex: 1, accentColor: theme.accent }} />
              <span style={{ fontSize: 12, width: 42, textAlign: 'right' }}>{compressSec.toFixed(2)}s</span>
            </div>
            <div style={{ fontSize: 10.5, color: theme.textDim, margin: '6px 0 8px', lineHeight: 1.5 }}>设置整段口播的停顿时长。较长的停顿压缩到这个长度,较短的从原始录音恢复。</div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, color: theme.text, margin: '0 0 8px', cursor: 'pointer' }}>
              <input type="checkbox" checked={removeFillers} onChange={(e) => setRemoveFillers(e.target.checked)} style={{ accentColor: theme.accent }} />
              去掉填充词(嗯 / 呃 / um / uh…)
            </label>
            {pauseResult && <div style={{ fontSize: 11, color: theme.text, marginBottom: 8 }}>{pauseResult}</div>}
            <button onClick={applyPause} disabled={!hasWords} style={{ ...toolBtn, width: '100%', background: theme.accent, color: '#fff', opacity: hasWords ? 1 : 0.5, justifyContent: 'center' }}>{editable ? '应用(压缩静音)' : '预览可省时长'}</button>
          </div>
        )}
      </div>

      {editMode && editable && (
        <div style={{ padding: '7px 14px', fontSize: 11.5, color: theme.textDim, borderBottom: `1px solid ${theme.border}`, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>点词删除/恢复(删词 = 剪掉那段音视频)。已删 <b style={{ color: theme.text }}>{deleted.size}</b> 词</span>
          {deleted.size > 0 && <button onClick={() => onClearEdits(audioItem!.id)} style={{ ...toolBtn, padding: '3px 8px' }}>还原全部</button>}
        </div>
      )}

      {/* body */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: 14 }}>
        {!hasWords ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button onClick={() => run(sourcePath)} disabled={busy} style={{ ...toolBtn, alignSelf: 'flex-start', background: theme.accent, color: '#fff', opacity: busy ? 0.6 : 1 }}>
              {busy ? (status === 'uploading' ? '上传中…' : '转写中…') : `转写 ${track}`}
            </button>
            <div style={{ fontSize: 11.5, color: theme.textDim, lineHeight: 1.6 }}>转写 <b>{track}</b> 轨:{sourceLabel}。AssemblyAI 词级 + 说话人分离。</div>
            {status === 'error' && <div style={{ fontSize: 11, color: '#f88' }}>{error}</div>}
          </div>
        ) : view === 'paragraph' ? (
          <ParagraphView groups={groups} deleted={deleted} editMode={editMode && editable} onWord={onWord} />
        ) : (
          <SegmentView groups={groups} deleted={deleted} editMode={editMode && editable} onWord={onWord} fps={fps} />
        )}
      </div>

      <CaptionsControls captions={captions} hasTranscript={hasWords} onGenerate={generateCaptions} onUpdate={onUpdateCaptions} onTranslate={onTranslate} translating={translating} translateError={translateError} />
    </div>
  );
}

const toolBtn: React.CSSProperties = { background: theme.panelAlt, color: theme.text, border: `1px solid ${theme.border}`, borderRadius: 6, padding: '6px 10px', fontSize: 12, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 };
const selectStyle: React.CSSProperties = { background: theme.panelAlt, color: theme.text, border: `1px solid ${theme.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 12 };
const popover: React.CSSProperties = { position: 'absolute', top: 44, left: 14, width: 300, background: theme.panel, border: `1px solid ${theme.borderLight}`, borderRadius: 8, padding: 12, zIndex: 20, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' };
