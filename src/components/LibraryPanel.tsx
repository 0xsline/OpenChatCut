import { useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import { theme } from '../theme';
import type { Tpl } from '../types';
import { AUDIO_ASSETS, type AudioAsset } from '../audio/library';
import { TranscriptPanel } from './TranscriptPanel';

interface LibraryPanelProps {
  templates: Tpl[];
  onAddTemplate: (tpl: Tpl) => void;
  onAddAudio: (asset: AudioAsset) => void;
  playerRef: RefObject<PlayerRef | null>;
  fps: number;
}

const MAIN_TABS = ['我的素材', '资源库', '文字稿'] as const;
const SUB_TABS = ['G 动画', '音效', '转场', '特效', '缩放', 'LUT', 'Audio'] as const;

// group templates by category, preserving first-seen order
function CATEGORIES(templates: Tpl[]): { cat: string; items: Tpl[] }[] {
  const map = new Map<string, Tpl[]>();
  for (const t of templates) {
    if (!map.has(t.category)) map.set(t.category, []);
    map.get(t.category)!.push(t);
  }
  return [...map.entries()].map(([cat, items]) => ({ cat, items }));
}

export function LibraryPanel({ templates, onAddTemplate, onAddAudio, playerRef, fps }: LibraryPanelProps) {
  const [mainTab, setMainTab] = useState<(typeof MAIN_TABS)[number]>('资源库');
  const [subTab, setSubTab] = useState<(typeof SUB_TABS)[number]>('G 动画');
  const showAudio = mainTab === '资源库' && (subTab === 'Audio' || subTab === '音效');
  const isTranscript = mainTab === '文字稿';

  return (
    <section style={{ display: 'flex', flexDirection: 'column', borderRight: `1px solid ${theme.border}`, background: theme.panel, minHeight: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 16, padding: '10px 16px 0', fontSize: 13 }}>
        {MAIN_TABS.map((t) => (
          <button key={t} onClick={() => setMainTab(t)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', paddingBottom: 8, color: mainTab === t ? theme.text : theme.textDim, fontWeight: mainTab === t ? 600 : 400, borderBottom: `2px solid ${mainTab === t ? theme.text : 'transparent'}` }}>{t}</button>
        ))}
      </div>
      {isTranscript ? (
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, borderTop: `1px solid ${theme.border}` }}>
          <TranscriptPanel playerRef={playerRef} fps={fps} />
        </div>
      ) : (
      <>
      <div style={{ display: 'flex', gap: 14, padding: '10px 16px', fontSize: 12, borderBottom: `1px solid ${theme.border}`, flexWrap: 'wrap' }}>
        {SUB_TABS.map((t) => (
          <button key={t} onClick={() => setSubTab(t)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: subTab === t ? theme.text : theme.textDim, borderBottom: `2px solid ${subTab === t ? theme.accent : 'transparent'}`, paddingBottom: 4 }}>{t}</button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 12, minHeight: 0 }}>
        {mainTab === '资源库' && subTab === 'G 动画' ? (
          <>
            <div style={{ fontSize: 11, color: theme.textDim, marginBottom: 8 }}>{templates.length} 个模板</div>
            {CATEGORIES(templates).map(({ cat, items }) => (
              <div key={cat} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, color: theme.textDim, margin: '4px 2px 8px', textTransform: 'capitalize' }}>{cat} · {items.length}</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 10 }}>
                  {items.map((tp) => (
                    <button key={tp.id} onClick={() => onAddTemplate(tp)} title={`点击加到时间线：${tp.name}`}
                      style={{ cursor: 'pointer', textAlign: 'left', padding: 0, overflow: 'hidden', border: `1px solid ${theme.border}`, borderRadius: 8, background: theme.panelAlt, color: theme.text }}>
                      <div style={{ aspectRatio: '16 / 9', background: '#0c0c0c', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
                        {tp.thumb ? (
                          <img src={tp.thumb} alt={tp.name} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        ) : (
                          <span style={{ fontSize: 20, color: theme.textDim }}>＋</span>
                        )}
                      </div>
                      <div style={{ padding: '5px 7px', fontSize: 10.5, lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tp.name}</div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </>
        ) : showAudio ? (
          <>
            <div style={{ fontSize: 11, color: theme.textDim, marginBottom: 8 }}>{AUDIO_ASSETS.length} 个音频 · 点击加到 A1</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {AUDIO_ASSETS.map((a) => (
                <button key={a.id} onClick={() => onAddAudio(a)} title={`点击加到 A1 轨:${a.name}`}
                  style={{ cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px', border: `1px solid ${theme.border}`, borderRadius: 8, background: theme.panelAlt, color: theme.text }}>
                  <span style={{ fontSize: 16 }}>🎵</span>
                  <span style={{ flex: 1, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</span>
                  <span style={{ fontSize: 10.5, color: theme.textDim }}>{Math.round(a.durationInFrames / 30)}s</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div style={{ color: theme.textDim, fontSize: 12, padding: 8 }}>「{mainTab} · {subTab}」内容待接入。</div>
        )}
      </div>
      </>
      )}
    </section>
  );
}
