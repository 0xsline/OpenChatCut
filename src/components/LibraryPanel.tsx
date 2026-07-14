import { useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import { theme } from '../theme';
import type { Tpl } from '../types';
import type { MediaAsset, TimelineItem, TransitionType, ZoomShape } from '../editor/types';
import { GLSL_TRANSITION_TYPES, TRANSITION_LABELS, ZOOM_SHAPE_LABELS } from '../editor/types';
import type { CaptionsData } from '../captions/types';
import type { TranscriptWord } from '../transcript/types';
import { AUDIO_ASSETS, type AudioAsset } from '../audio/library';
import { ALL_FX, FX_EFFECTS, FX_IDS, LUT_EFFECTS, LUT_IDS } from '../gl/fx/effects';
import { fxThumbUrl } from '../gl/fxThumb';
import { TranscriptPanel } from './TranscriptPanel';
import { MediaPoolPanel } from './MediaPoolPanel';
import { TemplateBrowser } from './TemplateBrowser';
import { ResourceBrowser, type ResourceItem } from './ResourceBrowser';

// the 2 built-in LUTs (source luts_items.json) — implemented via published
// camera-log transfer functions (source ships them as real .cube data on its
// CDN; we don't fetch its backend). Apply like an fx effect.
const LUT_ITEMS: ResourceItem[] = LUT_IDS.map((id) => ({ id, name: LUT_EFFECTS[id].name, desc: LUT_EFFECTS[id].desc }));
const TRANSITION_ITEMS: ResourceItem[] = (Object.keys(TRANSITION_LABELS) as TransitionType[]).map((t) => ({
  id: t, name: TRANSITION_LABELS[t], badge: GLSL_TRANSITION_TYPES.has(t) ? 'GLSL' : undefined,
}));
const FX_ITEMS: ResourceItem[] = FX_IDS.map((id) => ({ id, name: FX_EFFECTS[id].name, desc: FX_EFFECTS[id].desc }));
const ZOOM_ITEMS: ResourceItem[] = (Object.keys(ZOOM_SHAPE_LABELS) as ZoomShape[]).map((s) => ({ id: s, name: ZOOM_SHAPE_LABELS[s] }));

interface LibraryPanelProps {
  templates: Tpl[];
  onAddTemplate: (tpl: Tpl) => void;
  onAddAudio: (asset: AudioAsset) => void;
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
  assets: MediaAsset[];
  onImportMedia: (file: File) => Promise<void>;
  onAddMediaItem: (asset: MediaAsset) => void;
  /** ⋮ menu「用 AI 生成」: seed the chat with this template as a reference */
  onUseTemplateAI: (tpl: Tpl) => void;
  /** currently-selected clip — resource-library tabs apply to it */
  selectedItem: TimelineItem | null;
  onApplyTransition: (type: TransitionType) => void;
  onApplyFx: (assetId: string) => void;
  onApplyZoom: (shape: ZoomShape) => void;
}

const MAIN_TABS = ['我的素材', '资源库', '文字稿'] as const;
const SUB_TABS = ['MG 动画', '音效', '转场', '特效', '缩放', 'LUT', 'Audio'] as const;

export function LibraryPanel({ templates, onAddTemplate, onAddAudio, playerRef, fps, items, captions, onSetCaptions, onUpdateCaptions, onSetItemTranscript, onToggleWord, onCleanScript, onClearEdits, assets, onImportMedia, onAddMediaItem, onUseTemplateAI, selectedItem, onApplyTransition, onApplyFx, onApplyZoom }: LibraryPanelProps) {
  const selKind = selectedItem?.kind ?? null;
  const isVisual = selKind != null && selKind !== 'audio';
  const [mainTab, setMainTab] = useState<(typeof MAIN_TABS)[number]>('资源库');
  const [subTab, setSubTab] = useState<(typeof SUB_TABS)[number]>('MG 动画');
  const showAudio = mainTab === '资源库' && (subTab === 'Audio' || subTab === '音效');
  const isTranscript = mainTab === '文字稿';
  const isMyAssets = mainTab === '我的素材';

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
          <TranscriptPanel playerRef={playerRef} fps={fps} items={items} captions={captions} onSetCaptions={onSetCaptions} onUpdateCaptions={onUpdateCaptions} onSetItemTranscript={onSetItemTranscript} onToggleWord={onToggleWord} onCleanScript={onCleanScript} onClearEdits={onClearEdits} />
        </div>
      ) : isMyAssets ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, borderTop: `1px solid ${theme.border}` }}>
          <MediaPoolPanel assets={assets} fps={fps} onImport={onImportMedia} onAddAsset={onAddMediaItem} />
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
        {mainTab === '资源库' && subTab === 'MG 动画' ? (
          <TemplateBrowser templates={templates} onAdd={onAddTemplate} onUseAI={onUseTemplateAI} />
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
        ) : subTab === '转场' ? (
          <ResourceBrowser hint="点击应用为选中片段的入场转场（从前一个相邻同轨片段进入）" items={TRANSITION_ITEMS}
            applicable={selectedItem != null} onApply={(id) => onApplyTransition(id as TransitionType)} />
        ) : subTab === '特效' ? (
          <ResourceBrowser hint="点击把 WebGL 特效应用到选中的视频/图片片段" items={FX_ITEMS}
            applicable={selKind === 'video' || selKind === 'image'} onApply={(id) => onApplyFx(id)}
            thumb={(id) => fxThumbUrl(ALL_FX[id])} />
        ) : subTab === '缩放' ? (
          <ResourceBrowser hint="点击给选中片段加一个缩放动画（默认 1.5×，可在属性面板细调）" items={ZOOM_ITEMS}
            applicable={isVisual} onApply={(id) => onApplyZoom(id as ZoomShape)} />
        ) : subTab === 'LUT' ? (
          <ResourceBrowser hint="点击把相机 log→Rec.709 调色应用到选中的视频/图片（强度可在属性面板细调；公式实现）" items={LUT_ITEMS}
            applicable={selKind === 'video' || selKind === 'image'} onApply={(id) => onApplyFx(id)}
            thumb={(id) => fxThumbUrl(ALL_FX[id])} />
        ) : (
          <div style={{ color: theme.textDim, fontSize: 12, padding: 8 }}>「{mainTab} · {subTab}」内容待接入。</div>
        )}
      </div>
      </>
      )}
    </section>
  );
}
