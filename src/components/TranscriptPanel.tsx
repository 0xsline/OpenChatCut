import type { RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import { theme } from '../theme';
import { useTranscript } from '../transcript/useTranscript';
import { msToFrame } from '../transcript/types';

interface TranscriptPanelProps {
  playerRef: RefObject<PlayerRef | null>;
  fps: number;
  samplePath?: string;
}

const STATUS_LABEL: Record<string, string> = {
  idle: '',
  uploading: '上传中…',
  processing: '转写中…（AssemblyAI 词级时间戳)',
  done: '',
  error: '出错',
};

// 文字稿面板:转写示例语音 → 词级文字稿,点词跳转播放头(词↔帧同步)。
export function TranscriptPanel({ playerRef, fps, samplePath = '/media/speech-sample.mp3' }: TranscriptPanelProps) {
  const { status, result, error, run } = useTranscript();
  const busy = status === 'uploading' || status === 'processing';

  return (
    <div style={{ padding: 12, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          onClick={() => run(samplePath)}
          disabled={busy}
          style={{ cursor: busy ? 'default' : 'pointer', background: theme.accent, color: '#fff', border: 'none', borderRadius: 6, padding: '7px 12px', fontSize: 12, opacity: busy ? 0.6 : 1 }}
        >
          {busy ? STATUS_LABEL[status] : '转写示例语音'}
        </button>
        {status === 'error' && <span style={{ fontSize: 11, color: '#f88' }}>{error}</span>}
        {status === 'done' && result && <span style={{ fontSize: 11, color: theme.textDim }}>{result.words.length} 个词 · 点词跳转</span>}
      </div>

      {!result ? (
        <div style={{ fontSize: 12, color: theme.textDim, lineHeight: 1.6 }}>
          点「转写示例语音」用 AssemblyAI 生成词级文字稿。转写后点任意词,预览播放头会跳到该词的时间点。
        </div>
      ) : (
        <div style={{ fontSize: 13, lineHeight: 1.9, color: theme.text }}>
          {result.words.map((w, i) => (
            <span
              key={i}
              onClick={() => playerRef.current?.seekTo(msToFrame(w.start, fps))}
              title={`${(w.start / 1000).toFixed(2)}s`}
              style={{ cursor: 'pointer', padding: '1px 2px', borderRadius: 3 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = theme.accent)}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              {w.text}{' '}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
