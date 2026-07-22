import { useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import { theme } from '../theme';
import { useT } from '../i18n/locale';
import type { Tpl } from '../types';
import type { MediaAsset, MediaFolder, TimelineItem, TrackId, TransitionItem, TransitionType, ZoomShape } from '../editor/types';
import type { MobileUploadRecord } from '../media/mobileUploadApi';
import { AUDIO_TRANSITION_ORDER, TRANSITION_LABELS, TRANSITION_ORDER, ZOOM_SHAPE_LABELS, ZOOM_SHAPE_ORDER } from '../editor/types';
import type { CaptionsData } from '../captions/types';
import type { TranscriptWord } from '../transcript/types';
import type { AudioAsset } from '../audio/library';
import { FX_EFFECTS, FX_IDS, LUT_EFFECTS, LUT_IDS } from '../gl/fx/effects';
import { TranscriptPanel, type TranscriptTrackOption } from '../transcript/TranscriptPanel';
import { CaptionsPanel } from '../captions/CaptionsPanel';
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
import type { SerializableFxDef } from '../gl/fx/uniforms';
import { Icon } from '../components/icons';
import {
  AUDIO_FX_ISOLATE_DEFAULT,
  AUDIO_FX_ISOLATE_LIGHT,
  AUDIO_FX_ISOLATE_STRONG,
} from '../audio/isolateVoice';

// Two built-in LUTs implemented with published camera-log transfer functions.
// They apply through the same pipeline as other effects.
const LUT_ITEMS: ResourceItem[] = LUT_IDS.map((id) => ({ id, name: LUT_EFFECTS[id].name }));
/** 画面转场 — GLSL transitions in catalog order. */
const TRANSITION_ITEMS: ResourceItem[] = TRANSITION_ORDER.map((t) => ({
  id: t, name: TRANSITION_LABELS[t],
}));
/** 音频转场 — trAudioCrossFade. */
const AUDIO_CROSSFADE_THUMB = '/library-previews/audio-crossfade.jpg';
const AUDIO_TRANSITION_ITEMS: ResourceItem[] = AUDIO_TRANSITION_ORDER.map((t) => ({
  id: t, name: TRANSITION_LABELS[t],
  badge: '音频',
  thumb: AUDIO_CROSSFADE_THUMB,
}));
const FX_ITEMS: ResourceItem[] = FX_IDS.map((id) => ({ id, name: FX_EFFECTS[id].name }));
const ZOOM_ITEMS: ResourceItem[] = ZOOM_SHAPE_ORDER.map((s) => ({ id: s, name: ZOOM_SHAPE_LABELS[s] }));
/** 音频效果 — open-box isolate_voice presets (strength via id). Thumbs in assets/library-previews. */
const AUDIO_FX_THUMBS: Record<string, string> = {
  [AUDIO_FX_ISOLATE_DEFAULT]: '/library-previews/isolate-voice.jpg',
  [AUDIO_FX_ISOLATE_LIGHT]: '/library-previews/isolate-voice-light.jpg',
  [AUDIO_FX_ISOLATE_STRONG]: '/library-previews/isolate-voice-strong.jpg',
};
const AUDIO_FX_ITEMS: ResourceItem[] = [
  {
    id: AUDIO_FX_ISOLATE_DEFAULT,
    name: '人声隔离',
    desc: '开箱 ffmpeg 频谱降噪 · 强度 70',
    badge: 'AI',
    thumb: AUDIO_FX_THUMBS[AUDIO_FX_ISOLATE_DEFAULT],
  },
  {
    id: AUDIO_FX_ISOLATE_LIGHT,
    name: '人声隔离（轻）',
    desc: '轻度降噪 · 干净麦 · 强度 35',
    badge: '轻',
    thumb: AUDIO_FX_THUMBS[AUDIO_FX_ISOLATE_LIGHT],
  },
  {
    id: AUDIO_FX_ISOLATE_STRONG,
    name: '人声隔离（强）',
    desc: '强力降噪 · 嘈杂环境 · 强度 90',
    badge: '强',
    thumb: AUDIO_FX_THUMBS[AUDIO_FX_ISOLATE_STRONG],
  },
];

interface LibraryPanelProps {
  semanticScopeId: string;
  templates: Tpl[];
  onAddTemplate: (tpl: Tpl) => void;
  onAddAudio: (asset: AudioAsset) => void;
  playerRef: RefObject<PlayerRef | null>;
  fps: number;
  items: TimelineItem[];
  /** A1/V1 aliases + names for 文字稿 track picker */
  trackOptions: TranscriptTrackOption[];
  captionTracks: Array<TranscriptTrackOption & { captions: CaptionsData | null }>;
  onSetCaptions: (c: CaptionsData | null, track?: TrackId) => void;
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
  onImportMedia: (file: File, onProgress?: (ratio: number) => void) => Promise<MediaAsset>;
  onImportMobileMedia: (record: MobileUploadRecord) => Promise<void>;
  onAddMediaItem: (asset: MediaAsset) => void;
  onCreateMediaFolder: (name: string, parentId?: string) => string;
  onRenameMediaFolder: (id: string, name: string) => void;
  onDeleteMediaFolder: (id: string) => void;
  onMoveMediaAssets: (ids: string[], folderId?: string) => void;
  onRenameMediaAsset: (id: string, name: string) => void;
  onSetMediaAssetFavorite: (id: string, favorite: boolean) => void;
  onRemoveMediaAsset: (id: string) => void;
  onRelinkMediaAsset?: (id: string, next: { src: string; name?: string; durationInFrames?: number; width?: number; height?: number; kind?: MediaAsset['kind'] }) => void;
  onAddSolid?: () => void;
  /** ⋮ menu「用 AI 生成」: seed the chat with this template as a reference */
  onUseTemplateAI: (tpl: Tpl) => void;
  /** 扩展中心「创作」的数据源 */
  transitions: TransitionItem[];
  fxDefs: Record<string, SerializableFxDef>;
  /** currently-selected clip — resource-library tabs apply to it */
  selectedItem: TimelineItem | null;
  /** custom = 插件转场(type='custom-shader' 时快照 frag 进 TransitionItem) */
  onApplyTransition: (type: TransitionType, custom?: { frag: string; uniforms: Record<string, number>; label: string }) => void;
  onApplyFx: (assetId: string) => void;
  /** 内置曲线传 {shape};插件曲线传 {envelope,label}(见 PluginBrowser.asPluginZoom) */
  onApplyZoom: (zoom: ZoomEffect) => void;
  /** 音频效果（人声隔离等）应用到选中 video/audio */
  onApplyAudioFx?: (audioFxId: string) => void | Promise<void>;
}

const MAIN_TABS = ['我的素材', '资源库', '文字稿', '字幕'] as const;
const SUB_TABS = ['MG 动画', '音效', '音频效果', '转场', '特效', '缩放', 'LUT'] as const;
export function LibraryPanel({ semanticScopeId, templates, onAddTemplate, onAddAudio, playerRef, fps, items, trackOptions, captionTracks, onSetCaptions, onUpdateCaptions, onSetItemTranscript, onToggleWord, onCleanScript, onSetGapCap, onSetTranscriptPlayOrder, onReorderTrackItems, onClearEdits, assets, mediaFolders, onImportMedia, onImportMobileMedia, onAddMediaItem, onCreateMediaFolder, onRenameMediaFolder, onDeleteMediaFolder, onMoveMediaAssets, onRenameMediaAsset, onSetMediaAssetFavorite, onRemoveMediaAsset, onRelinkMediaAsset, onAddSolid, onUseTemplateAI, transitions, fxDefs, selectedItem, onApplyTransition, onApplyFx, onApplyZoom, onApplyAudioFx }: LibraryPanelProps) {
  const t = useT();
  const selKind = selectedItem?.kind ?? null;
  const isVisual = selKind != null && selKind !== 'audio';
  const [mainTab, setMainTab] = useState<(typeof MAIN_TABS)[number]>('我的素材');
  const [subTab, setSubTab] = useState<(typeof SUB_TABS)[number]>('MG 动画');
  const [extensionOpen, setExtensionOpen] = useState(false);
  // 已装扩展条目并入各分类(带「扩展」角标);缩放/转场在 onApply 里按 id 分流
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
  // 音频转场：源 catalog 无独立条目，已隐藏假入口（§4.2）
  const showSfx = mainTab === '资源库' && subTab === '音效';     // sound effects
  const isTranscript = mainTab === '文字稿';
  const isCaptions = mainTab === '字幕';
  const isMyAssets = mainTab === '我的素材';
  const openCaptionStyles = (sourceItemIds: string[]) => {
    const target = captionTracks[0];
    if (!target) return;
    if (!target.captions && sourceItemIds.length) {
      onSetCaptions({ enabled: true, template: 'black-bar', pacing: 'phrase', sourceItemId: sourceItemIds[0]!, sources: sourceItemIds.length > 1 ? sourceItemIds : undefined, sourceMode: sourceItemIds.length > 1 ? 'item' : undefined, bilingual: false }, target.id);
    }
    setMainTab('字幕');
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
        <ExtensionCenter items={items} transitions={transitions} fxDefs={fxDefs} onClose={() => setExtensionOpen(false)} />
      ) : isCaptions ? (
        <CaptionsPanel playerRef={playerRef} fps={fps} items={items} captionTracks={captionTracks} onSetCaptions={onSetCaptions} onUpdateCaptions={onUpdateCaptions} />
      ) : isTranscript ? (
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, borderTop: `0.5px solid ${theme.border}` }}>
          <TranscriptPanel playerRef={playerRef} fps={fps} items={items} trackOptions={trackOptions} onSetItemTranscript={onSetItemTranscript} onToggleWord={onToggleWord} onCleanScript={onCleanScript} onSetGapCap={onSetGapCap} onSetTranscriptPlayOrder={onSetTranscriptPlayOrder} onReorderTrackItems={onReorderTrackItems} onClearEdits={onClearEdits} onOpenCaptionStyles={captionTracks.length ? openCaptionStyles : undefined} />
        </div>
      ) : isMyAssets ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, borderTop: `0.5px solid ${theme.border}` }}>
          <MediaPoolPanel semanticScopeId={semanticScopeId} assets={assets} folders={mediaFolders} fps={fps} onImport={onImportMedia} onImportMobile={onImportMobileMedia} onAddAsset={onAddMediaItem}
            onCreateFolder={onCreateMediaFolder} onRenameFolder={onRenameMediaFolder} onDeleteFolder={onDeleteMediaFolder}
            onMoveAssets={onMoveMediaAssets} onRenameAsset={onRenameMediaAsset} onSetFavorite={onSetMediaAssetFavorite} onRemoveAsset={onRemoveMediaAsset}
            onRelinkAsset={onRelinkMediaAsset} onAddSolid={onAddSolid} />
        </div>
      ) : (
      <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px 7px 16px', fontSize: 12, borderBottom: `0.5px solid ${theme.border}` }}>
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
        ) : subTab === '音频效果' ? (
          <ResourceBrowser
            layout="grid"
            dragKind="audio-fx"
            hint="点击应用到选中视频/音频（开箱人声隔离 · 也可拖到时间线片段）"
            items={AUDIO_FX_ITEMS}
            applicable={(selKind === 'video' || selKind === 'audio') && !!onApplyAudioFx}
            disabledNote={
              (selKind === 'video' || selKind === 'audio')
              && selectedItem
              && !selectedItem.src?.startsWith('/media/uploads/')
                ? '需先上传到媒体池（/media/uploads）'
                : undefined
            }
            onApply={(id) => { void onApplyAudioFx?.(id); }}
            thumb={(id) => AUDIO_FX_THUMBS[id] ?? ''}
          />
        ) : subTab === '转场' ? (
          <div className="cc-transition-browser">
            {/* 音频交叉淡化 — trAudioCrossFade；选中音频片段时高亮可用 */}
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
              // 内置与 plugin:/custom: 同一套 A/B 样片 + hover 0→1 预览(真 GLSL)
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
              // 插件包络:真样片 + 包络缩放动画(与内置 ZoomThumb 同观感)
              return pluginZoom?.envelope
                ? <EnvelopeThumb envelope={pluginZoom.envelope} magnification={pluginZoom.magnification} playing={hovered} />
                : <ZoomThumb shape={id as ZoomShape} playing={hovered} />;
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
