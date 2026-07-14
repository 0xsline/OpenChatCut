import { useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import { theme } from '../theme';
import type { Tpl } from '../types';
import type { GlslTransitionType, MediaAsset, MediaFolder, TimelineItem, TransitionType, ZoomShape } from '../editor/types';
import { TRANSITION_LABELS, TRANSITION_ORDER, ZOOM_SHAPE_LABELS, ZOOM_SHAPE_ORDER } from '../editor/types';
import type { CaptionsData } from '../captions/types';
import type { TranscriptWord } from '../transcript/types';
import type { AudioAsset } from '../audio/library';
import { FX_EFFECTS, FX_IDS, LUT_EFFECTS, LUT_IDS } from '../gl/fx/effects';
import { TranscriptPanel, type TranscriptTrackOption } from '../transcript/TranscriptPanel';
import { MediaPoolPanel } from '../media/MediaPoolPanel';
import { TemplateBrowser } from './TemplateBrowser';
import { ResourceBrowser, type ResourceItem } from './ResourceBrowser';
import { TransitionThumb } from './TransitionThumb';
import { FxThumb } from './FxThumb';
import { ZoomThumb } from './ZoomThumb';
import { SoundBrowser } from './SoundBrowser';
import { AudioFxBrowser } from './AudioFxBrowser';

// the 2 built-in LUTs (source luts_items.json) — implemented via published
// camera-log transfer functions (source ships them as real .cube data on its
// CDN; we don't fetch its backend). Apply like an fx effect.
const LUT_ITEMS: ResourceItem[] = LUT_IDS.map((id) => ({ id, name: LUT_EFFECTS[id].name }));
/** 画面转场 — 12 source video GLSL transitions in catalog order */
const TRANSITION_ITEMS: ResourceItem[] = TRANSITION_ORDER.map((t) => ({
  id: t, name: TRANSITION_LABELS[t],
}));
const FX_ITEMS: ResourceItem[] = FX_IDS.map((id) => ({ id, name: FX_EFFECTS[id].name }));
const ZOOM_ITEMS: ResourceItem[] = ZOOM_SHAPE_ORDER.map((s) => ({ id: s, name: ZOOM_SHAPE_LABELS[s] }));

interface LibraryPanelProps {
  templates: Tpl[];
  onAddTemplate: (tpl: Tpl) => void;
  onAddAudio: (asset: AudioAsset) => void;
  playerRef: RefObject<PlayerRef | null>;
  fps: number;
  items: TimelineItem[];
  /** A1/V1 aliases + names for 文字稿 track picker */
  trackOptions: TranscriptTrackOption[];
  captions: CaptionsData | null;
  onSetCaptions: (c: CaptionsData | null) => void;
  onUpdateCaptions: (patch: Partial<CaptionsData>) => void;
  onSetItemTranscript: (id: string, words: TranscriptWord[]) => void;
  onToggleWord: (id: string, idx: number) => void;
  onCleanScript: (id: string, opts: { silenceFrames?: number; removeFillers: boolean }) => void;
  onSetGapCap: (id: string, afterWordIndex: number, maxMs: number | null) => void;
  onSetTranscriptPlayOrder: (id: string, playOrder: number[] | null) => void;
  onReorderTrackItems: (track: string, orderedIds: string[]) => void;
  onClearEdits: (id: string) => void;
  assets: MediaAsset[];
  mediaFolders: MediaFolder[];
  onImportMedia: (file: File) => Promise<void>;
  onAddMediaItem: (asset: MediaAsset) => void;
  onCreateMediaFolder: (name: string, parentId?: string) => string;
  onRenameMediaFolder: (id: string, name: string) => void;
  onDeleteMediaFolder: (id: string) => void;
  onMoveMediaAssets: (ids: string[], folderId?: string) => void;
  onRenameMediaAsset: (id: string, name: string) => void;
  onSetMediaAssetFavorite: (id: string, favorite: boolean) => void;
  onRelinkMediaAsset?: (id: string, next: { src: string; name?: string; durationInFrames?: number; width?: number; height?: number; kind?: MediaAsset['kind'] }) => void;
  onAddSolid?: () => void;
  /** ⋮ menu「用 AI 生成」: seed the chat with this template as a reference */
  onUseTemplateAI: (tpl: Tpl) => void;
  /** currently-selected clip — resource-library tabs apply to it */
  selectedItem: TimelineItem | null;
  onApplyTransition: (type: TransitionType) => void;
  onApplyFx: (assetId: string) => void;
  onApplyZoom: (shape: ZoomShape) => void;
  onApplyIsolate?: (itemId: string, denoisedSrc: string, strength: number) => void;
  onClearIsolate?: (itemId: string) => void;
}

const MAIN_TABS = ['我的素材', '资源库', '文字稿'] as const;
const SUB_TABS = ['MG 动画', '音效', '转场', '特效', '缩放', 'LUT', 'Audio'] as const;
export function LibraryPanel({ templates, onAddTemplate, onAddAudio, playerRef, fps, items, trackOptions, captions, onSetCaptions, onUpdateCaptions, onSetItemTranscript, onToggleWord, onCleanScript, onSetGapCap, onSetTranscriptPlayOrder, onReorderTrackItems, onClearEdits, assets, mediaFolders, onImportMedia, onAddMediaItem, onCreateMediaFolder, onRenameMediaFolder, onDeleteMediaFolder, onMoveMediaAssets, onRenameMediaAsset, onSetMediaAssetFavorite, onRelinkMediaAsset, onAddSolid, onUseTemplateAI, selectedItem, onApplyTransition, onApplyFx, onApplyZoom, onApplyIsolate, onClearIsolate }: LibraryPanelProps) {
  const selKind = selectedItem?.kind ?? null;
  const isVisual = selKind != null && selKind !== 'audio';
  const [mainTab, setMainTab] = useState<(typeof MAIN_TABS)[number]>('我的素材');
  const [subTab, setSubTab] = useState<(typeof SUB_TABS)[number]>('MG 动画');
  // 音频转场：源 catalog 无独立条目，已隐藏假入口（§4.2）
  const showAudioFx = mainTab === '资源库' && subTab === 'Audio'; // source Audio FX (not BGM)
  const showSfx = mainTab === '资源库' && subTab === '音效';     // sound effects
  const isTranscript = mainTab === '文字稿';
  const isMyAssets = mainTab === '我的素材';

  return (
    <section className="cc-library-panel">
      <div className="cc-main-tabs">
        {MAIN_TABS.map((t) => (
          <button key={t} onClick={() => setMainTab(t)}
            className={`cc-main-tab${mainTab === t ? ' selected' : ''}`}>{t}</button>
        ))}
      </div>
      {isTranscript ? (
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, borderTop: `1px solid ${theme.border}` }}>
          <TranscriptPanel playerRef={playerRef} fps={fps} items={items} trackOptions={trackOptions} captions={captions} onSetCaptions={onSetCaptions} onUpdateCaptions={onUpdateCaptions} onSetItemTranscript={onSetItemTranscript} onToggleWord={onToggleWord} onCleanScript={onCleanScript} onSetGapCap={onSetGapCap} onSetTranscriptPlayOrder={onSetTranscriptPlayOrder} onReorderTrackItems={onReorderTrackItems} onClearEdits={onClearEdits} />
        </div>
      ) : isMyAssets ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, borderTop: `1px solid ${theme.border}` }}>
          <MediaPoolPanel assets={assets} folders={mediaFolders} fps={fps} onImport={onImportMedia} onAddAsset={onAddMediaItem}
            onCreateFolder={onCreateMediaFolder} onRenameFolder={onRenameMediaFolder} onDeleteFolder={onDeleteMediaFolder}
            onMoveAssets={onMoveMediaAssets} onRenameAsset={onRenameMediaAsset} onSetFavorite={onSetMediaAssetFavorite}
            onRelinkAsset={onRelinkMediaAsset} onAddSolid={onAddSolid} />
        </div>
      ) : (
      <>
      <div style={{ display: 'flex', gap: 14, padding: '10px 16px', fontSize: 12, borderBottom: `1px solid ${theme.border}`, flexWrap: 'wrap' }}>
        {SUB_TABS.map((t) => (
          <button key={t} onClick={() => setSubTab(t)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: subTab === t ? theme.text : theme.textDim, borderBottom: `2px solid ${subTab === t ? theme.accent : 'transparent'}`, paddingBottom: 4 }}>{t}</button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 10px 14px', minHeight: 0 }}>
        {mainTab === '资源库' && subTab === 'MG 动画' ? (
          <TemplateBrowser templates={templates} onAdd={onAddTemplate} onUseAI={onUseTemplateAI} />
        ) : showAudioFx ? (
          <AudioFxBrowser
            selectedItem={selectedItem}
            onApply={(id, src, strength) => onApplyIsolate?.(id, src, strength)}
            onClear={(id) => onClearIsolate?.(id)}
          />
        ) : showSfx ? (
          <SoundBrowser fps={fps} onAdd={onAddAudio} />
        ) : subTab === '转场' ? (
          <div className="cc-transition-browser">
            <ResourceBrowser
              layout="grid"
              dragKind="transition"
              hint="悬停预览 · 点击应用到选中片段（入场，需前一个相邻同轨片段）"
              items={TRANSITION_ITEMS}
              applicable={selectedItem != null}
              onApply={(id) => onApplyTransition(id as TransitionType)}
              renderThumb={(id, hovered) => (
                <TransitionThumb type={id as GlslTransitionType} playing={hovered} />
              )}
            />
          </div>
        ) : subTab === '特效' ? (
          <ResourceBrowser
            layout="grid"
            dragKind="fx"
            hint="悬停预览 · 点击应用到选中视频/图片"
            items={FX_ITEMS}
            applicable={selKind === 'video' || selKind === 'image'}
            onApply={(id) => onApplyFx(id)}
            renderThumb={(id, hovered) => <FxThumb assetId={id} playing={hovered} />}
          />
        ) : subTab === '缩放' ? (
          <ResourceBrowser
            layout="grid"
            dragKind="zoom"
            hint="悬停预览 · 点击应用到选中片段（默认 1.5×，属性可细调）"
            items={ZOOM_ITEMS}
            applicable={isVisual}
            onApply={(id) => onApplyZoom(id as ZoomShape)}
            renderThumb={(id, hovered) => <ZoomThumb shape={id as ZoomShape} playing={hovered} />}
          />
        ) : subTab === 'LUT' ? (
          <ResourceBrowser
            layout="grid"
            dragKind="lut"
            hint="悬停预览 · 点击应用到选中视频/图片（强度可在属性细调）"
            items={LUT_ITEMS}
            applicable={selKind === 'video' || selKind === 'image'}
            onApply={(id) => onApplyFx(id)}
            renderThumb={(id, hovered) => <FxThumb assetId={id} playing={hovered} />}
          />
        ) : (
          <div style={{ color: theme.textDim, fontSize: 12, padding: 8 }}>「{mainTab} · {subTab}」内容待接入。</div>
        )}
      </div>
      </>
      )}
    </section>
  );
}
