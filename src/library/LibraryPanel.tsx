import { useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import { theme } from '../theme';
import { useT } from '../i18n/locale';
import type { Tpl } from '../types';
import type { MediaAsset, MediaFolder, TimelineItem, TrackId, TransitionType, ZoomShape } from '../editor/types';
import type { MobileUploadRecord } from '../media/mobileUploadApi';
import { AUDIO_TRANSITION_ORDER, TRANSITION_LABELS, TRANSITION_ORDER, ZOOM_SHAPE_LABELS, ZOOM_SHAPE_ORDER } from '../editor/types';
import type { CaptionsData } from '../captions/types';
import type { TranscriptWord } from '../transcript/types';
import type { AudioAsset } from '../audio/library';
import { FX_EFFECTS, FX_IDS, LUT_EFFECTS, LUT_IDS } from '../gl/fx/effects';
import { TranscriptPanel, type TranscriptTrackOption } from '../transcript/TranscriptPanel';
import { CaptionsPanel } from '../captions/CaptionsPanel';
import { newManualCaptions } from '../captions/manualCaptions';
import { MediaPoolPanel } from '../media/MediaPoolPanel';
import { TemplateBrowser } from './TemplateBrowser';
import { ResourceBrowser, type ResourceItem } from './ResourceBrowser';
import { TransitionThumb } from './TransitionThumb';
import { FxThumb } from './FxThumb';
import { ZoomThumb } from './ZoomThumb';
import { SoundBrowser } from './SoundBrowser';
import { EnvelopeThumb } from './PluginBrowser';
import { asPluginZoom, pluginResourceItems, usePluginPacks } from './pluginResources';
import { ExtensionCenter } from './ExtensionCenter';
import { isPluginAssetId } from '../plugins/types';
import { customTransitionUniforms, getCustomTransition } from '../gl/customTransitions';
import type { ZoomEffect } from '../editor/types';
import { Icon } from '../components/icons';
import { parseSrt } from '../captions/srt';

// Two built-in LUTs implemented with published camera-log transfer functions.
// They apply through the same pipeline as other effects.
const LUT_ITEMS: ResourceItem[] = LUT_IDS.map((id) => ({ id, name: LUT_EFFECTS[id].name }));
/** Screen transitions — GLSL transitions in catalog order. */
const TRANSITION_ITEMS: ResourceItem[] = TRANSITION_ORDER.map((t) => ({
  id: t, name: TRANSITION_LABELS[t],
}));
/** Audio transition — trAudioCrossFade. */
const AUDIO_CROSSFADE_THUMB = '/library-previews/audio-crossfade.jpg';
const AUDIO_TRANSITION_ITEMS: ResourceItem[] = AUDIO_TRANSITION_ORDER.map((t) => ({
  id: t, name: TRANSITION_LABELS[t],
  badge: '音频',
  thumb: AUDIO_CROSSFADE_THUMB,
}));
const FX_ITEMS: ResourceItem[] = FX_IDS.map((id) => ({ id, name: FX_EFFECTS[id].name }));
const ZOOM_ITEMS: ResourceItem[] = ZOOM_SHAPE_ORDER.map((s) => ({ id: s, name: ZOOM_SHAPE_LABELS[s] }));
export interface SequenceLibraryOption {
  id: string;
  name: string;
  durationInFrames: number;
  disabledReason?: string;
}

interface LibraryPanelProps {
  semanticScopeId: string;
  templates: Tpl[];
  onAddTemplate: (tpl: Tpl) => void;
  onAddAudio: (asset: AudioAsset) => void;
  playerRef: RefObject<PlayerRef | null>;
  fps: number;
  items: TimelineItem[];
  sequenceOptions: SequenceLibraryOption[];
  onAddSequence: (timelineId: string) => void;
  /** A1/V1 aliases + names for script track picker */
  trackOptions: TranscriptTrackOption[];
  captionTracks: Array<TranscriptTrackOption & { captions: CaptionsData | null }>;
  onSetCaptions: (c: CaptionsData | null, track?: TrackId) => void;
  onCreateCaptionTrack: (captions: CaptionsData, opts?: { name?: string; order?: number }) => TrackId;
  onUpdateCaptions: (patch: Partial<CaptionsData>, track?: TrackId) => void;
  onSetItemTranscript: (id: string, words: TranscriptWord[]) => void;
  onToggleWord: (id: string, idx: number) => void;
  onCleanScript: (id: string, opts: { silenceFrames?: number; removeFillers: boolean }) => void;
  onSetGapCap: (id: string, afterWordIndex: number, maxMs: number | null) => void;
  onSetTranscriptPlayOrder: (id: string, playOrder: number[] | null) => void;
  onReorderTrackItems: (track: string, orderedIds: string[]) => void;
  onClearEdits: (id: string) => void;
  assets: MediaAsset[];
  mediaFolders: MediaFolder[];
  offlineAssetIds: ReadonlySet<string>;
  onAssetLoadError: (asset: MediaAsset) => void;
  onImportMedia: (file: File, onProgress?: (ratio: number) => void) => Promise<MediaAsset>;
  onImportMobileMedia: (record: MobileUploadRecord) => Promise<void>;
  onAddMediaItem: (asset: MediaAsset) => void;
  onAddMediaItems?: (assets: MediaAsset[]) => void;
  onCreateMediaFolder: (name: string, parentId?: string) => string;
  onRenameMediaFolder: (id: string, name: string) => void;
  onDeleteMediaFolder: (id: string) => void;
  onMoveMediaAssets: (ids: string[], folderId?: string) => void;
  onRenameMediaAsset: (id: string, name: string) => void;
  onSetMediaAssetFavorite: (id: string, favorite: boolean) => void;
  onRemoveMediaAsset: (id: string) => void;
  onRelinkMediaAsset?: (id: string, next: { src: string; name?: string; durationInFrames?: number; width?: number; height?: number; kind?: MediaAsset['kind']; sourceRevision?: string; sourceSize?: number; sourceModifiedAt?: number }) => void;
  onAddSolid?: () => void;
  /** ⋮ menu「Generated with AI」: seed the chat with this template as a reference */
  onUseTemplateAI: (tpl: Tpl) => void;
  /** currently-selected clip — resource-library tabs apply to it */
  selectedItem: TimelineItem | null;
  /** custom = plugin transition (type='custom-shader' snapshot frag into TransitionItem) */
  onApplyTransition: (type: TransitionType, custom?: { frag: string; uniforms: Record<string, number>; label: string }) => void;
  onApplyFx: (assetId: string) => void;
  /** The built-in curve passes {shape}; the plugin curve passes {envelope, label} (see PluginBrowser.asPluginZoom) */
  onApplyZoom: (zoom: ZoomEffect) => void;
}

const MAIN_TABS = ['我的素材', '序列', '资源库', '文字稿', '字幕'] as const;
const SUB_TABS = ['MG 动画', '音效', '转场', '特效', '缩放', 'LUT'] as const;
export function LibraryPanel({ semanticScopeId, templates, onAddTemplate, onAddAudio, playerRef, fps, items, sequenceOptions, onAddSequence, trackOptions, captionTracks, onSetCaptions, onCreateCaptionTrack, onUpdateCaptions, onSetItemTranscript, onToggleWord, onCleanScript, onSetGapCap, onSetTranscriptPlayOrder, onReorderTrackItems, onClearEdits, assets, mediaFolders, offlineAssetIds, onAssetLoadError, onImportMedia, onImportMobileMedia, onAddMediaItem, onAddMediaItems, onCreateMediaFolder, onRenameMediaFolder, onDeleteMediaFolder, onMoveMediaAssets, onRenameMediaAsset, onSetMediaAssetFavorite, onRemoveMediaAsset, onRelinkMediaAsset, onAddSolid, onUseTemplateAI, selectedItem, onApplyTransition, onApplyFx, onApplyZoom }: LibraryPanelProps) {
  const t = useT();
  const selKind = selectedItem?.kind ?? null;
  const isVisual = selKind != null && selKind !== 'audio';
  const [mainTab, setMainTab] = useState<(typeof MAIN_TABS)[number]>('我的素材');
  const [subTab, setSubTab] = useState<(typeof SUB_TABS)[number]>('MG 动画');
  const [extensionOpen, setExtensionOpen] = useState(false);
  // The installed extension items are merged into each category (with the "Extension" corner mark); zoom/transition is split by id in onApply
  const pluginPacks = usePluginPacks();
  const transitionItems = [...TRANSITION_ITEMS, ...pluginResourceItems(pluginPacks, 'transition')];
  const fxItems = [...FX_ITEMS, ...pluginResourceItems(pluginPacks, 'fx')];
  const lutItems = [...LUT_ITEMS, ...pluginResourceItems(pluginPacks, 'lut')];
  const zoomItems = [...ZOOM_ITEMS, ...pluginResourceItems(pluginPacks, 'zoom')];
  const applyTransitionById = (id: string) => {
    if (!isPluginAssetId(id)) { onApplyTransition(id as TransitionType); return; }
    const def = getCustomTransition(id);
    if (def) onApplyTransition('custom-shader', { frag: def.frag, uniforms: customTransitionUniforms(def), label: def.label });
  };
  const applyZoomById = (id: string) => {
    const data = zoomItems.find((x) => x.id === id)?.data;
    const pluginZoom = data ? asPluginZoom(data) : null;
    onApplyZoom(pluginZoom ?? { shape: id as ZoomShape, magnification: 1.5, envelope: undefined, label: undefined });
  };
  // Audio transition: The source catalog has no independent entries and the false entry has been hidden (§4.2)
  const showSfx = mainTab === '资源库' && subTab === '音效';     // sound effects
  const isTranscript = mainTab === '文字稿';
  const isCaptions = mainTab === '字幕';
  const isMyAssets = mainTab === '我的素材';
  const isSequences = mainTab === '序列';
  const openCaptionStyles = (sourceItemIds: string[]) => {
    const target = captionTracks[0];
    if (!target?.captions && sourceItemIds.length) {
      onSetCaptions({ enabled: true, template: 'black-bar', pacing: 'phrase', sourceItemId: sourceItemIds[0]!, sources: sourceItemIds.length > 1 ? sourceItemIds : undefined, sourceMode: sourceItemIds.length > 1 ? 'item' : undefined, bilingual: false }, target?.id);
    }
    setMainTab('字幕');
  };
  const importSrt = async (file: File) => {
    try {
      const words = parseSrt(await file.text());
      const entryId = `srt_${crypto.randomUUID()}`;
      onCreateCaptionTrack({
        ...newManualCaptions(),
        sourceEntries: [{ id: entryId, itemId: `manual:${entryId}`, label: file.name, words }],
      }, { name: file.name.replace(/\.srt$/i, '') || file.name });
      setMainTab('字幕');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      window.alert(`${t('SRT 导入失败')}：${t(detail)}`);
    }
  };

  return (
    <section className="cc-library-panel">
      <div className="cc-main-tabs">
        {MAIN_TABS.map((tab) => (
          <button key={tab} onClick={() => { setExtensionOpen(false); setMainTab(tab); }}
            className={`cc-main-tab${mainTab === tab ? ' selected' : ''}`}>{t(tab)}</button>
        ))}
      </div>
      {extensionOpen ? (
        <ExtensionCenter onClose={() => setExtensionOpen(false)} />
      ) : isCaptions ? (
        <CaptionsPanel playerRef={playerRef} fps={fps} items={items} captionTracks={captionTracks} onSetCaptions={onSetCaptions} onUpdateCaptions={onUpdateCaptions} />
      ) : isTranscript ? (
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, borderTop: `0.5px solid ${theme.border}` }}>
          <TranscriptPanel playerRef={playerRef} fps={fps} items={items} trackOptions={trackOptions} onSetItemTranscript={onSetItemTranscript} onToggleWord={onToggleWord} onCleanScript={onCleanScript} onSetGapCap={onSetGapCap} onSetTranscriptPlayOrder={onSetTranscriptPlayOrder} onReorderTrackItems={onReorderTrackItems} onClearEdits={onClearEdits} onImportSrt={(file) => { void importSrt(file); }} onOpenCaptionStyles={openCaptionStyles} />
        </div>
      ) : isSequences ? (
        <div className="cc-sequence-panel">
          <div className="cc-sequence-hint">
            {t('点击把序列作为引用实例加入当前时间线；修改子序列会同步到所有实例。')}
          </div>
          <div className="cc-sequence-list">
            {sequenceOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={!!option.disabledReason}
                title={option.disabledReason}
                onClick={() => onAddSequence(option.id)}
                className="cc-sequence-row"
              >
                <span className="cc-sequence-name">{option.name}</span>
                <span className="cc-sequence-duration">{(option.durationInFrames / fps).toFixed(1)}s</span>
              </button>
            ))}
          </div>
        </div>
      ) : isMyAssets ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, borderTop: `0.5px solid ${theme.border}` }}>
          <MediaPoolPanel semanticScopeId={semanticScopeId} assets={assets} folders={mediaFolders} fps={fps} offlineAssetIds={offlineAssetIds} onAssetLoadError={onAssetLoadError} onImport={onImportMedia} onImportMobile={onImportMobileMedia} onAddAsset={onAddMediaItem} onAddAssets={onAddMediaItems}
            onCreateFolder={onCreateMediaFolder} onRenameFolder={onRenameMediaFolder} onDeleteFolder={onDeleteMediaFolder}
            onMoveAssets={onMoveMediaAssets} onRenameAsset={onRenameMediaAsset} onSetFavorite={onSetMediaAssetFavorite} onRemoveAsset={onRemoveMediaAsset}
            onRelinkAsset={onRelinkMediaAsset} onAddSolid={onAddSolid} />
        </div>
      ) : (
      <>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, padding: '10px 12px 7px 16px', fontSize: 12, borderBottom: `0.5px solid ${theme.border}` }}>
        <div style={{ display: 'flex', gap: 14, minWidth: 0, overflowX: 'auto', whiteSpace: 'nowrap', flex: 1 }}>
          {SUB_TABS.map((tab) => (
            <button key={tab} onClick={() => setSubTab(tab)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: subTab === tab ? theme.text : theme.textDim, borderBottom: `2px solid ${subTab === tab ? theme.accent : 'transparent'}`, padding: '0 0 4px' }}>{t(tab)}</button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setExtensionOpen(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            flex: '0 0 auto',
            border: `0.5px solid ${theme.border}`,
            borderRadius: 4,
            background: theme.panelAlt,
            color: theme.text,
            padding: '4px 7px',
            fontSize: 10.5,
            cursor: 'pointer',
          }}
        >
          <Icon name="grid" size={12} />
          {t('扩展中心')}
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 10px 14px', minHeight: 0 }}>
        {mainTab === '资源库' && subTab === 'MG 动画' ? (
          <TemplateBrowser templates={templates} onAdd={onAddTemplate} onUseAI={onUseTemplateAI} />
        ) : showSfx ? (
          <SoundBrowser fps={fps} onAdd={onAddAudio} />
        ) : subTab === '转场' ? (
          <div className="cc-transition-browser">
            {/* Audio crossfade — trAudioCrossFade; highlighting available when audio clip is selected*/}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: theme.textDim, margin: '0 4px 8px', letterSpacing: 0.3 }}>
                {t('音频转场 · Audio Cross Fade')}
              </div>
              <ResourceBrowser
                layout="grid"
                dragKind="transition"
                hint="点击应用到选中音频（需同轨前一段相邻音频）。出点渐弱、入点渐强。"
                items={AUDIO_TRANSITION_ITEMS}
                applicable={selKind === 'audio'}
                onApply={(id) => onApplyTransition(id as TransitionType)}
                thumb={() => AUDIO_CROSSFADE_THUMB}
              />
            </div>
            <div style={{ fontSize: 11, color: theme.textDim, margin: '0 4px 8px', letterSpacing: 0.3 }}>
              {t('画面转场 · Video')}
            </div>
            <ResourceBrowser
              layout="grid"
              dragKind="transition"
              hint="悬停预览 · 点击应用到选中画面片段（入场，需前一个相邻同轨片段）"
              items={transitionItems}
              applicable={selectedItem != null && selKind !== 'audio'}
              onApply={applyTransitionById}
              // Built-in and plugin:/custom: the same set of A/B samples + hover 0→1 preview (true GLSL)
              renderThumb={(id, hovered) => <TransitionThumb type={id} playing={hovered} />}
            />
          </div>
        ) : subTab === '特效' ? (
          <ResourceBrowser
            layout="grid"
            dragKind="fx"
            hint="悬停预览 · 点击应用到选中视频/图片"
            items={fxItems}
            applicable={selKind === 'video' || selKind === 'image'}
            onApply={(id) => onApplyFx(id)}
            renderThumb={(id, hovered) => <FxThumb assetId={id} playing={hovered} />}
          />
        ) : subTab === '缩放' ? (
          <ResourceBrowser
            layout="grid"
            dragKind="zoom"
            hint="悬停预览 · 点击应用到选中片段（默认 1.5×，属性可细调）"
            items={zoomItems}
            applicable={isVisual}
            onApply={applyZoomById}
            renderThumb={(id, hovered) => {
              const data = zoomItems.find((x) => x.id === id)?.data;
              const pluginZoom = data ? asPluginZoom(data) : null;
              // plugin envelope: real sample + envelope zoom animation (same look and feel as built-in ZoomThumb)
              if (pluginZoom?.envelope) {
                return <EnvelopeThumb envelope={pluginZoom.envelope} magnification={pluginZoom.magnification} playing={hovered} />;
              }
              return <ZoomThumb shape={pluginZoom?.shape ?? id as ZoomShape} playing={hovered} />;
            }}
          />
        ) : subTab === 'LUT' ? (
          <ResourceBrowser
            layout="grid"
            dragKind="lut"
            hint="悬停预览 · 点击应用到选中视频/图片（强度可在属性细调）"
            items={lutItems}
            applicable={selKind === 'video' || selKind === 'image'}
            onApply={(id) => onApplyFx(id)}
            renderThumb={(id, hovered) => <FxThumb assetId={id} playing={hovered} />}
          />
        ) : (
          <div style={{ color: theme.textDim, fontSize: 12, padding: 8 }}>{t('「{main} · {sub}」内容待接入。', { main: t(mainTab), sub: t(subTab) })}</div>
        )}
      </div>
      </>
      )}
    </section>
  );
}
