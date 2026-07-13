import { useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import { theme } from '../theme';
import type { TimelineItem, TrackId } from '../editor/types';
import { useTranscript } from '../transcript/useTranscript';
import { msToFrame, type TranscriptWord } from '../transcript/types';
import { toParagraphs, toSegments, speakerLabel, analyzeSilences } from '../transcript/segment';
import { CaptionsControls } from './CaptionsControls';
import type { CaptionsData } from '../captions/types';

interface TranscriptPanelProps {
  playerRef: RefObject<PlayerRef | null>;
  fps: number;
  items: TimelineItem[];
  captions: CaptionsData | null;
  onSetCaptions: (c: CaptionsData | null) => void;
  onUpdateCaptions: (patch: Partial<CaptionsData>) => void;
}

const TRACKS: TrackId[] = ['V1', 'V2', 'A1', 'A2'];
const SAMPLE = '/media/speech-sample.mp3';

// 文字稿面板 — 忠实源站:轨道选择 + 说话人分段 + 段落/片段视图 + 停顿工具。
export function TranscriptPanel({ playerRef, fps, items, captions, onSetCaptions, onUpdateCaptions }: TranscriptPanelProps) {
  const { status, result, error, run } = useTranscript();
  const [track, setTrack] = useState<TrackId>('A1');
  const [view, setView] = useState<'paragraph' | 'segment'>('paragraph');
  const [pauseOpen, setPauseOpen] = useState(false);
  const [compressSec, setCompressSec] = useState(0.5);
  const [pauseResult, setPauseResult] = useState<string | null>(null);
  const busy = status === 'uploading' || status === 'processing';

  const audioItem = items.find((it) => it.kind === 'audio' && it.track === track && it.src);
  const sourcePath = audioItem?.src ?? SAMPLE;
  const sourceLabel = audioItem ? audioItem.name : '示例语音（该轨无音频）';

  const seek = (w: TranscriptWord) => playerRef.current?.seekTo(msToFrame(w.start, fps));
  const applyPause = () => {
    if (!result) return;
    // ponytail: 分析停顿(真正压缩音频需要 transcript-editing 引擎重排源区间,此处先给出结果)
    const { count, savedMs } = analyzeSilences(result.words, compressSec * 1000);
    setPauseResult(`> ${compressSec}s 的停顿 ${count} 处 → 压缩后省 ${(savedMs / 1000).toFixed(1)}s`);
  };
  const generateCaptions = () => {
    if (!result) return;
    onSetCaptions({
      enabled: true,
      template: captions?.template ?? 'tiktok',
      pacing: captions?.pacing ?? 'phrase',
      offsetFrames: audioItem?.startFrame ?? 0,
      words: result.words,
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      {/* toolbar */}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: `1px solid ${theme.border}`, fontSize: 12 }}>
        <button onClick={() => setPauseOpen((v) => !v)} style={toolBtn}>⏱ 停顿</button>
        <select value={view} onChange={(e) => setView(e.target.value as 'paragraph' | 'segment')} style={selectStyle}>
          <option value="paragraph">段落视图</option>
          <option value="segment">片段视图</option>
        </select>
        <span style={{ flex: 1 }} />
        <select value={track} onChange={(e) => { setTrack(e.target.value as TrackId); }} style={selectStyle}>
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
            {pauseResult && <div style={{ fontSize: 11, color: theme.text, marginBottom: 8 }}>{pauseResult}</div>}
            <button onClick={applyPause} disabled={!result} style={{ ...toolBtn, width: '100%', background: theme.accent, color: '#fff', opacity: result ? 1 : 0.5, justifyContent: 'center' }}>应用</button>
          </div>
        )}
      </div>

      {/* body */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: 14 }}>
        {!result ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button onClick={() => run(sourcePath)} disabled={busy} style={{ ...toolBtn, alignSelf: 'flex-start', background: theme.accent, color: '#fff', opacity: busy ? 0.6 : 1 }}>
              {busy ? (status === 'uploading' ? '上传中…' : '转写中…') : `转写 ${track}`}
            </button>
            <div style={{ fontSize: 11.5, color: theme.textDim, lineHeight: 1.6 }}>
              转写 <b>{track}</b> 轨:{sourceLabel}。AssemblyAI 词级时间戳 + 说话人分离;转写后点任意词跳转播放头。
            </div>
            {status === 'error' && <div style={{ fontSize: 11, color: '#f88' }}>{error}</div>}
          </div>
        ) : view === 'paragraph' ? (
          <ParagraphView utterancesResult={result.utterances} onWord={seek} />
        ) : (
          <SegmentView utterancesResult={result.utterances} onWord={seek} fps={fps} />
        )}
      </div>

      <CaptionsControls captions={captions} hasTranscript={!!result} onGenerate={generateCaptions} onUpdate={onUpdateCaptions} />
    </div>
  );
}

function WordRow({ words, onWord }: { words: TranscriptWord[]; onWord: (w: TranscriptWord) => void }) {
  return (
    <span style={{ fontSize: 13, lineHeight: 1.9, color: theme.text }}>
      {words.map((w, i) => (
        <span key={i} onClick={() => onWord(w)} title={`${(w.start / 1000).toFixed(2)}s`}
          style={{ cursor: 'pointer', padding: '1px 2px', borderRadius: 3 }}
          onMouseEnter={(e) => (e.currentTarget.style.background = theme.accent)}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
          {w.text}{' '}
        </span>
      ))}
    </span>
  );
}

function ParagraphView({ utterancesResult, onWord }: { utterancesResult: import('../transcript/types').TranscriptUtterance[]; onWord: (w: TranscriptWord) => void }) {
  const paras = toParagraphs(utterancesResult);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {paras.map((p, i) => (
        <div key={i}>
          <div style={{ color: '#5b9bff', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{speakerLabel(p.speaker)}</div>
          <WordRow words={p.words} onWord={onWord} />
        </div>
      ))}
    </div>
  );
}

function SegmentView({ utterancesResult, onWord, fps }: { utterancesResult: import('../transcript/types').TranscriptUtterance[]; onWord: (w: TranscriptWord) => void; fps: number }) {
  const segs = toSegments(utterancesResult);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {segs.map((s, i) => (
        <div key={i} style={{ display: 'flex', gap: 10, padding: '6px 8px', border: `1px solid ${theme.border}`, borderRadius: 6, background: theme.panelAlt }}>
          <div style={{ fontSize: 10, color: theme.textDim, fontVariantNumeric: 'tabular-nums', flexShrink: 0, width: 58 }}>
            <div style={{ color: '#5b9bff' }}>{speakerLabel(s.speaker)}</div>
            {msToFrame(s.start, fps)}f
          </div>
          <WordRow words={s.words} onWord={onWord} />
        </div>
      ))}
    </div>
  );
}

const toolBtn: React.CSSProperties = { background: theme.panelAlt, color: theme.text, border: `1px solid ${theme.border}`, borderRadius: 6, padding: '6px 10px', fontSize: 12, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 };
const selectStyle: React.CSSProperties = { background: theme.panelAlt, color: theme.text, border: `1px solid ${theme.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 12 };
const popover: React.CSSProperties = { position: 'absolute', top: 44, left: 14, width: 300, background: theme.panel, border: `1px solid ${theme.borderLight}`, borderRadius: 8, padding: 12, zIndex: 20, boxShadow: '0 8px 24px rgba(0,0,0,0.5)' };
