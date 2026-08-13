import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { Player, Thumbnail, type CallbackListener, type PlayerRef } from '@remotion/player';
import { theme, themeAlpha } from '../theme';
import { TimelineComposition } from '../editor/TimelineComposition';
import type { SelectedPreviewStatus, SelectedPreviewStatusListener } from '../gl/previewAdapter';
import {
  captionTrackEntries,
  type ProjectDoc,
  type ClipTransform,
  type KeyframeProp,
  type TimelineItem,
  type TimelineState,
  type TrackId,
} from '../editor/types';
import { canvasRegionRef, emitSelectionRef, regionFromDrag, useSelectionRefMode } from '../agent/selection-refs';
import { CaptionPreviewEditor } from '../captions/CaptionPreviewEditor';
import type { CaptionSelectionRef } from '../captions/captionSelection';
import type { CaptionsData } from '../captions/types';
import {
  onCaptionStylePointerDrop,
  type CaptionStyleDragPayload,
} from '../captions/captionStyleDrag';
import { appendDroppedManualCaption } from '../captions/manualCaptions';
import { Icon } from './icons';
import { useT } from '../i18n/locale';
import { ReviewCommentsButton, type ReviewOpenRequest } from '../review/ReviewCommentsButton';
import { usePreviewProjectDoc } from '../media/previewMedia';
import {
  getPreviewSourceMode,
  setPreviewSourceMode,
  subscribeQualityMode,
  type PreviewSourceMode,
} from '../media/qualityPolicy';
import type { SlipPreview } from '../editor/slip';
import { SlipTwoUpPreview } from './SlipTwoUpPreview';
import { PREVIEW_SHARED_AUDIO_TAGS } from './previewAudioPool';
import { SafeZoneOverlay } from './SafeZoneOverlay';
import { PreviewTransformOverlay } from './preview/PreviewTransformOverlay';
import { fitPreviewCanvasSize, type PreviewCanvasSize } from './preview/previewCanvasGeometry';

const MEDIA_LOADING_NOTICE_DELAY_MS = 160;

const PREVIEW_SOURCE_CYCLE: readonly PreviewSourceMode[] = ['auto', 'original', 'proxy'];

function previewStatusKey(status: Pick<SelectedPreviewStatus, 'kind' | 'targetId'>): string {
  return `${status.kind}\u0000${status.targetId}`;
}

function PreviewSourceToggle() {
  const t = useT();
  const mode = useSyncExternalStore(subscribeQualityMode, getPreviewSourceMode, getPreviewSourceMode);
  const label = mode === 'original' ? t('高清') : mode === 'proxy' ? t('流畅') : t('自动');
  const title = mode === 'original'
    ? t('高清：显示原始素材，画质最好，可能更吃性能')
    : mode === 'proxy'
      ? t('流畅：使用轻量副本，播放更流畅')
      : t('自动：跟随画质策略（画质优先=高清，均衡=流畅）');
  return (
    <button
      type="button"
      onClick={() => {
        const index = PREVIEW_SOURCE_CYCLE.indexOf(mode);
        setPreviewSourceMode(PREVIEW_SOURCE_CYCLE[(index + 1) % PREVIEW_SOURCE_CYCLE.length]!);
      }}
      title={title}
      aria-label={title}
      style={{
        fontSize: 11, lineHeight: 1, padding: '3px 8px', borderRadius: 5, cursor: 'pointer',
        border: `0.5px solid ${theme.border}`,
        background: mode === 'original' ? theme.panelAlt : 'transparent',
        color: mode === 'auto' ? theme.textDim : theme.text,
      }}
    >
      {t('预览画质')}: {label}
    </button>
  );
}

interface PreviewPanelProps {
  state: TimelineState;
  project: ProjectDoc;
  playerRef: RefObject<PlayerRef | null>;
  onImport: (file: File) => Promise<void>;
  offlineSrcs?: ReadonlySet<string>;
  /** Direct editing of canvas captions (check box + floating toolbar). If it has not been transmitted (such as proposal preview status), it is read-only. */
  onUpdateCaptions?: (patch: Partial<CaptionsData>, track?: TrackId) => void;
  onSelectCaption?: (selection: CaptionSelectionRef | null) => void;
  activeCaptionSelection?: CaptionSelectionRef | null;
  onSeedChat?: (text: string) => void;
  onSelectItem?: (id: string | null) => void;
  onSetItemTransform?: (id: string, patch: ClipTransform) => void;
  onSetItemKeyframe?: (id: string, prop: KeyframeProp, localFrame: number, value: number) => void;
  onBeginHistoryGesture?: () => void;
  onEndHistoryGesture?: () => void;
  onItemPropChange?: (id: string, key: string, value: unknown) => void;
  projectId: string;
  timelineId: string;
  reviewState: TimelineState;
  selectedItem: TimelineItem | null;
  reviewRequest?: ReviewOpenRequest | null;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  selectedPreviewStatuses?: readonly SelectedPreviewStatus[];
  onSelectedPreviewStatus?: SelectedPreviewStatusListener;
  slipPreview?: SlipPreview | null;
  hoverPreviewFrame?: number | null;
}

export const PreviewPanel = memo(function PreviewPanel({
  state, project, playerRef, onImport, offlineSrcs, onUpdateCaptions, onSelectCaption, activeCaptionSelection, onSeedChat,
  onSelectItem, onSetItemTransform, onSetItemKeyframe, onBeginHistoryGesture, onEndHistoryGesture,
  onItemPropChange,
  projectId, timelineId, reviewState, selectedItem, reviewRequest, inspectorOpen, onToggleInspector,
  selectedPreviewStatuses, onSelectedPreviewStatus, slipPreview,
  hoverPreviewFrame = null,
}: PreviewPanelProps) {
  const t = useT();
  const renderProject = useMemo<ProjectDoc>(() => ({
    ...project,
    timelines: project.timelines.map((timeline) => timeline.id === timelineId
      ? { ...timeline, ...state, id: timeline.id, name: timeline.name, order: timeline.order }
      : timeline),
  }), [project, state, timelineId]);
  const preview = usePreviewProjectDoc(renderProject, timelineId);
  const duration = preview.plan.durationInFrames;
  const playerInputProps = useMemo(() => ({
    state: preview.state,
    project: preview.project,
    timelineId,
    selectedItemId: selectedItem?.id,
    onSelectedPreviewStatus,
  }), [preview.state, preview.project, timelineId, selectedItem?.id, onSelectedPreviewStatus]);
  const thumbnailInputProps = useMemo(() => ({
    state: preview.state,
    project: preview.project,
    timelineId,
  }), [preview.state, preview.project, timelineId]);
  const inputRef = useRef<HTMLInputElement>(null);
  const videoBoxRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState<PreviewCanvasSize>({ width: 0, height: 0 });
  const [busy, setBusy] = useState(false);
  const [showSafe, setShowSafe] = useState(false);
  const [autoEditCaption, setAutoEditCaption] = useState<{ trackId: TrackId; laneId: string } | null>(null);
  // Expose Player during full screen preview (` shortcut key/timeline toolbar button to make Player full screen)
  // Comes with a control bar; the editing state still uses the timeline transport, and does not display dual sets of controls.
  // Must listen to Remotion's own fullscreenchange: it walks the webkit legacy API in Chrome,
  // The document standard event is not guaranteed to be triggered, the SDK emitter is the real source.
  const [fullscreen, setFullscreen] = useState(false);
  const transformApi = onSelectItem && onSetItemTransform && onSetItemKeyframe
    && onBeginHistoryGesture && onEndHistoryGesture
    ? {
      onSelectItem,
      onSetItemTransform,
      onSetItemKeyframe,
      onBeginHistoryGesture,
      onEndHistoryGesture,
      onItemPropChange,
      onSeedChat,
    }
    : null;
  const hasItems = state.items.length > 0;
  const previewCanvasSize = fitPreviewCanvasSize(stageSize, {
    width: state.width,
    height: state.height,
  });
  const failedProxies = preview.proxies.filter(({ proxy }) => proxy.status === 'failed');
  const pendingProxies = preview.proxies.filter(({ proxy }) => proxy.status === 'loading').length;
  const shaderFallbacks = useMemo(
    () => (selectedPreviewStatuses ?? []).filter((status) => status.phase === 'fallback'),
    [selectedPreviewStatuses],
  );
  const durableShaderFallback = shaderFallbacks.find((status) => status.fallbackReason !== 'media-loading');
  const mediaLoadingFallbacks = useMemo(
    () => shaderFallbacks.filter((status) => status.fallbackReason === 'media-loading'),
    [shaderFallbacks],
  );
  const mediaLoadingKeys = useMemo(
    () => mediaLoadingFallbacks.map(previewStatusKey).sort(),
    [mediaLoadingFallbacks],
  );
  const mediaLoadingStartedAtRef = useRef(new Map<string, number>());
  const [visibleMediaLoading, setVisibleMediaLoading] = useState<{ key: string; startedAt: number } | null>(null);
  useEffect(() => {
    const startedAt = mediaLoadingStartedAtRef.current;
    const activeKeys = new Set(mediaLoadingKeys);
    for (const key of startedAt.keys()) {
      if (!activeKeys.has(key)) startedAt.delete(key);
    }
    const now = Date.now();
    for (const key of mediaLoadingKeys) {
      if (!startedAt.has(key)) startedAt.set(key, now);
    }
    let nextKey: string | undefined;
    let nextVisibleAt = Number.POSITIVE_INFINITY;
    for (const key of mediaLoadingKeys) {
      const visibleAt = startedAt.get(key)! + MEDIA_LOADING_NOTICE_DELAY_MS;
      if (visibleAt < nextVisibleAt) {
        nextKey = key;
        nextVisibleAt = visibleAt;
      }
    }
    if (!nextKey) return undefined;
    const nextStartedAt = startedAt.get(nextKey)!;
    const timeout = window.setTimeout(
      () => setVisibleMediaLoading({ key: nextKey, startedAt: nextStartedAt }),
      Math.max(0, nextVisibleAt - now),
    );
    return () => window.clearTimeout(timeout);
  }, [mediaLoadingKeys]);
  const visibleMediaLoadingFallback = mediaLoadingFallbacks.find((status) => {
    const key = previewStatusKey(status);
    if (!visibleMediaLoading || key !== visibleMediaLoading.key) return false;
    return mediaLoadingStartedAtRef.current.get(key) === visibleMediaLoading.startedAt;
  });
  const visibleShaderFallback = durableShaderFallback ?? visibleMediaLoadingFallback;
  const offlineNames = [...new Set(renderProject.timelines
    .filter((timeline) => preview.plan.timelineIds.includes(timeline.id))
    .flatMap((timeline) => timeline.items)
    .filter((item) => !!item.src && offlineSrcs?.has(item.src))
    .map((item) => item.name))];
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onChange: CallbackListener<'fullscreenchange'> = (e) => setFullscreen(e.detail.isFullscreen);
    player.addEventListener('fullscreenchange', onChange);
    return () => player.removeEventListener('fullscreenchange', onChange);
  }, [playerRef, hasItems]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      const next = { width: stage.clientWidth, height: stage.clientHeight };
      setStageSize((current) => (
        current.width === next.width && current.height === next.height ? current : next
      ));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    measure();
    return () => observer.disconnect();
  }, []);
  // Selection mode (canvas-region-marked): drag a marquee → region reference
  const pickMode = useSelectionRefMode();
  const importFiles = async (files: FileList | File[]) => {
    if (!files.length || busy) return;
    setBusy(true);
    try { for (const file of Array.from(files)) await onImport(file); }
    finally { setBusy(false); }
  };
  const dropCaptionStyle = (payload: CaptionStyleDragPayload | null, clientX: number, clientY: number): boolean => {
    const box = videoBoxRef.current;
    const entry = captionTrackEntries(state).find(({ id }) => id === payload?.trackId);
    if (!payload || !box || !entry?.captions || !onUpdateCaptions) return false;
    const rect = box.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return false;
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    const startMs = ((playerRef.current?.getCurrentFrame() ?? 0) / state.fps) * 1000;
    const dropped = appendDroppedManualCaption(entry.captions, state.items, payload.template, t('双击编辑字幕'), startMs, {
      anchor: 'middle-center', offsetXRatio: x - 0.5, offsetYRatio: y - 0.5,
    });
    if (!dropped) return false;
    playerRef.current?.pause();
    onUpdateCaptions(dropped.patch, payload.trackId);
    setAutoEditCaption({ trackId: payload.trackId, laneId: dropped.laneId });
    return true;
  };
  useEffect(() => onCaptionStylePointerDrop(({ payload, clientX, clientY }) => {
    dropCaptionStyle(payload, clientX, clientY);
  }));
  return (
    <section style={{ display: 'flex', flex: 1, flexDirection: 'column', background: theme.panel, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
      <div className="cc-preview-header" style={{ height: 30, padding: '0 12px', display: 'flex', alignItems: 'center', borderBottom: `0.5px solid ${theme.border}`, flexShrink: 0 }}>
        <span style={{ fontSize: 12, color: theme.text }}>{t('预览')}</span>
        {pickMode && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginLeft: 10, fontSize: 11, color: theme.accent }}>
            <Icon name="cursor" size={11} />
            {t('选择模式：在画面上拖框选区作为引用')}
          </span>
        )}
        <div className="cc-preview-header-actions" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <ReviewCommentsButton
            projectId={projectId}
            timelineId={timelineId}
            state={reviewState}
            selectedItem={selectedItem}
            openRequest={reviewRequest}
            getCurrentFrame={() => playerRef.current?.getCurrentFrame() ?? 0}
            onSeek={(frame) => playerRef.current?.seekTo(frame)}
          />
          {state.items.length > 0 && (
            <PreviewSourceToggle />
          )}
          {state.items.length > 0 && (
            <button type="button" onClick={() => setShowSafe((v) => !v)} aria-pressed={showSafe}
              title={t('切换标题/动作安全区参考框（竖屏成片构图辅助）')}
              style={{
                fontSize: 11, lineHeight: 1, padding: '3px 8px', borderRadius: 5, cursor: 'pointer',
                border: `0.5px solid ${theme.border}`, background: showSafe ? theme.panelAlt : 'transparent',
                color: showSafe ? theme.text : theme.textDim,
              }}>
              {t('安全框')}
            </button>
          )}
          {selectedItem && (
            <button type="button" onClick={onToggleInspector} aria-pressed={inspectorOpen}
              title={inspectorOpen ? t('收起属性') : t('展开属性')}
              style={{
                fontSize: 11, lineHeight: 1, padding: '3px 8px', borderRadius: 5, cursor: 'pointer',
                border: `0.5px solid ${theme.border}`, background: inspectorOpen ? theme.panelAlt : 'transparent',
                color: inspectorOpen ? theme.text : theme.textDim,
              }}>
              {t('属性')}
            </button>
          )}
        </div>
      </div>
      <div ref={stageRef} className="cc-preview-stage"
        // Suppress the browser's native <video> context menu (download / picture-in-picture
        // / loop) because the preview is a canvas, not an exposed HTML5 video element.
        onContextMenu={(event) => event.preventDefault()}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
        onDrop={(event) => { event.preventDefault(); void importFiles(event.dataTransfer.files); }}>
        {state.items.length === 0 ? (
          <>
            <input ref={inputRef} type="file" accept="video/*,image/*,audio/*" multiple hidden onChange={(event) => { if (event.target.files) void importFiles(event.target.files); event.target.value = ''; }} />
            <button className="cc-preview-empty" disabled={busy} onClick={() => inputRef.current?.click()}>
              <Icon name="upload" size={24} />
              <span>{busy ? t('正在导入媒体…') : t('拖拽媒体到这里')}</span>
            </button>
          </>
        ) : (
          // Wrapper carries the sizing so the safe-zone overlay lines up exactly
          // on the video rect (Player fills the wrapper).
          <div ref={videoBoxRef} className="cc-preview-canvas" style={{
            position: 'relative',
            width: previewCanvasSize.width || (state.width >= state.height ? '100%' : 'auto'),
            height: previewCanvasSize.height || (state.width >= state.height ? 'auto' : '100%'),
            aspectRatio: `${state.width} / ${state.height}`,
          }} onErrorCapture={(event) => {
            if (!(event.target instanceof HTMLVideoElement)) return;
            const failedUrl = event.target.currentSrc || event.target.src;
            const source = preview.proxies.find(({ src, proxy }) => {
              const urls = [src, proxy.status === 'ready' ? proxy.previewSrc : ''].filter(Boolean);
              return urls.some((url) => new URL(url, window.location.href).href === failedUrl);
            });
            if (source) preview.requestFallback(source.src);
          }}>
            <Player
              ref={playerRef}
              component={TimelineComposition}
              inputProps={playerInputProps}
              durationInFrames={duration}
              fps={state.fps}
              compositionWidth={state.width}
              compositionHeight={state.height}
              numberOfSharedAudioTags={PREVIEW_SHARED_AUDIO_TAGS}
              // Full screen black: WebKit legacy full screen div does not automatically blacken the background, and the page checkerboard will be revealed on both sides.
              style={{ width: '100%', height: '100%', backgroundColor: fullscreen ? '#000' : undefined }}
              controls={fullscreen}
              // Playback runs only through the timeline transport
              // (play/pause button + Space shortcut), not the player itself. clickToPlay
              // off = clicking the frame doesn't toggle; spaceKeyToPlayOrPause off = the app
              // shortcut is the single Space handler (the Player's own handler would
              // double-toggle it to a no-op).
              clickToPlay={fullscreen}
              spaceKeyToPlayOrPause={false}
              // No loop: playback stops at the final frame (editor convention).
              // Restart by pressing play again.
            />
            {!fullscreen && hoverPreviewFrame !== null && (
              <div className="cc-preview-hover-frame" aria-label={t('时间线悬停预览')}>
                <Thumbnail
                  component={TimelineComposition}
                  inputProps={thumbnailInputProps}
                  frameToDisplay={hoverPreviewFrame}
                  durationInFrames={duration}
                  fps={state.fps}
                  compositionWidth={state.width}
                  compositionHeight={state.height}
                  style={{ display: 'block', width: '100%', aspectRatio: `${state.width} / ${state.height}` }}
                />
              </div>
            )}
            {slipPreview && <SlipTwoUpPreview preview={slipPreview} />}
            {offlineNames.length > 0 && (
              <div role="status" style={{
                position: 'absolute', top: 8, left: 8, right: 8, zIndex: 12,
                padding: '6px 10px', borderRadius: 6, background: themeAlpha.shadow(0.88),
                border: `1px solid ${theme.accent}`, color: theme.text, fontSize: 11,
              }}>
                {t('离线素材：{list}', { list: offlineNames.join('、') })}
              </div>
            )}
            {(pendingProxies > 0 || failedProxies.length > 0) && (
              <div role="status" style={{
                position: 'absolute', bottom: 8, left: 8, zIndex: 12,
                maxWidth: 'calc(100% - 16px)', padding: '5px 8px', borderRadius: 5,
                background: themeAlpha.shadow(0.84), color: failedProxies.length ? theme.accent : theme.textMuted,
                fontSize: 10,
              }}>
                {failedProxies.length
                  ? t('流畅预览暂不可用，已自动使用原画质播放（画面正常，不影响导出）')
                  : t('正在准备流畅预览…')}
              </div>
            )}
            {visibleShaderFallback && (
              <div role="status" aria-live="polite" style={{
                position: 'absolute', bottom: 8, right: 8, zIndex: 12,
                maxWidth: 'calc(100% - 16px)', padding: '5px 8px', borderRadius: 4,
                border: `0.5px solid ${theme.accent}`, background: themeAlpha.shadow(0.88),
                color: theme.text, fontSize: 10,
              }}>
                {visibleShaderFallback.fallbackReason === 'media-loading'
                  ? t('正在加载效果预览；暂时显示回退画面')
                  : visibleShaderFallback.adapter === 'css-transition'
                    ? t('着色器预览已回退为 CSS 近似；当前画面不代表导出效果')
                    : t('着色器预览不可用；当前显示未处理源画面')}
              </div>
            )}
            {showSafe && <SafeZoneOverlay />}
            {pickMode && <RegionPickOverlay state={state} playerRef={playerRef} />}
            {!pickMode && !fullscreen && transformApi && (
              <PreviewTransformOverlay state={state} playerRef={playerRef} {...transformApi} />
            )}
            {!pickMode && !fullscreen && onUpdateCaptions && captionTrackEntries(state).map(({ id, captions }) => captions?.enabled ? (
              <CaptionPreviewEditor
                key={id}
                trackId={id}
                state={state}
                captions={captions}
                playerRef={playerRef}
                onUpdateCaptions={(patch) => onUpdateCaptions(patch, id)}
                onSelectCaption={onSelectCaption}
                activeSelection={activeCaptionSelection}
                onSeedChat={onSeedChat}
                autoEditLaneId={autoEditCaption?.trackId === id ? autoEditCaption.laneId : undefined}
                onAutoEditHandled={() => setAutoEditCaption(null)}
              />
            ) : null)}
          </div>
        )}
      </div>
    </section>
  );
});


// Selection-mode marquee over the video rect: drag a rectangle → canvas-region
// reference in COMPOSITION coordinates, with the visual clips it covers at the
// current frame (emits openchatcut:canvas-region-marked).
function RegionPickOverlay({ state, playerRef }: { state: TimelineState; playerRef: RefObject<PlayerRef | null> }) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const pos = (event: React.PointerEvent) => {
    const rect = boxRef.current!.getBoundingClientRect();
    return {
      x: Math.min(Math.max(event.clientX - rect.left, 0), rect.width),
      y: Math.min(Math.max(event.clientY - rect.top, 0), rect.height),
    };
  };
  return (
    <div
      ref={boxRef}
      title={t('拖拽框选画面区域作为引用')}
      onPointerDown={(event) => {
        if (event.button !== 0) return; // left button only
        event.currentTarget.setPointerCapture(event.pointerId);
        const p = pos(event);
        setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      }}
      onPointerMove={(event) => {
        if (!drag) return;
        const p = pos(event);
        setDrag((d) => (d ? { ...d, x1: p.x, y1: p.y } : d));
      }}
      onPointerUp={() => {
        if (!drag || !boxRef.current) return;
        const rect = boxRef.current.getBoundingClientRect();
        const region = regionFromDrag(
          { x: drag.x0, y: drag.y0 }, { x: drag.x1, y: drag.y1 },
          rect.width, rect.height, state.width, state.height,
        );
        if (region) {
          emitSelectionRef(canvasRegionRef(region, Math.round(playerRef.current?.getCurrentFrame() ?? 0), state));
        }
        setDrag(null);
      }}
      style={{ position: 'absolute', inset: 0, zIndex: 5, cursor: 'crosshair', touchAction: 'none' }}
    >
      {drag && (
        <div style={{
          position: 'absolute',
          left: Math.min(drag.x0, drag.x1),
          top: Math.min(drag.y0, drag.y1),
          width: Math.abs(drag.x1 - drag.x0),
          height: Math.abs(drag.y1 - drag.y0),
          border: `0.5px solid ${theme.accent}`,
          background: themeAlpha.accent(0.14), // theme.accent @ 14%
          pointerEvents: 'none',
        }} />
      )}
    </div>
  );
}
