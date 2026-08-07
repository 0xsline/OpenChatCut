import { theme, themeAlpha } from '../../theme';
import {
  captionsOnTrack, selectedIdsOf, trackAlias, trackKind,
} from '../../editor/types';
import { ClipContextMenu } from './ClipContextMenu';
import { Icon } from '../icons';
import { CaptionStyleMenu } from '../../captions/CaptionStyleMenu';
import { CaptionTrackLane } from '../../captions/CaptionTrackLane';
import { captionSelectionsInFrameRange } from '../../captions/captionSelection';
import { removeManualCue } from '../../captions/manualCaptions';
import { TrackHead } from './TrackHead';
import { TrackLane } from './TrackLane';
import { TimelineToolbar } from './TimelineToolbar';
import { TimelineRuler } from './TimelineRuler';
import { MarkerEditor } from './MarkerEditor';
import { trackDeletePlan } from './trackDelete';
import { TrackContextMenu } from './TrackContextMenu';
import { closeCaptionTrackGaps, trackClearPlan } from './trackContextOperations';
import { isTimelineDragOverChat } from './timelineChatDrop';
import { HEADER_W, RULER_H } from './timelineUtil';
import {
  CAPTION_SELECTION_OWNER_SELECTOR,
  CAPTION_SELECTION_TIMELINE_CLIP_SELECTOR,
  CAPTION_SELECTION_TIMELINE_HEAD_SELECTOR,
  CAPTION_SELECTION_TIMELINE_REGION_SELECTOR,
  shouldClearCaptionSelectionFromPointer,
} from '../../captions/captionSelectionInteraction';
import type { TimelineProps } from './timelineTypes';
import { useTimelineController } from './useTimelineController';

export function Timeline(props: TimelineProps) {
  const {
    state, commands, playerRef, onRecordVoiceover, onReviewItem, onDropExternalFiles,
    selectedCaptions, onSelectCaption, onMarqueeCaptionSelect,
    t, locale, total, empty, trackIds, indexes, innerRef, scrollRef,
    relinkInputRef, trackInsertInputRef, seekGestureRef,
    hoverPreviewFrame, captionSelectionMovePreview, setCaptionSelectionMovePreview,
    commitTimelineSelectionMove, zoom, setZoom, px, metaOf,
    playheadRef, playheadLineRef, toolbarTimecodeRef, rulerTimecodeRef,
    playing, editMode, placeMode, setPlaceMode, snapping,
    captionsVisible, captionMenu, setCaptionMenu, trackMenu, setTrackMenu,
    duckMenu, setDuckMenu, captionError, setCaptionError,
    moveCaptionCue, openCaptionTrackMenu, openDuckTrackMenu,
    closeTrackDrillMenu, backFromTrackDrillMenu, recorder, toggleCaptions,
    pickMode, addSelectionToChat, ctxMenu, setCtxMenu, fxClip, setFxClip, clipJob, setClipJob,
    beginRelink, relinkFile, beginTrackInsert, insertTrackFiles, exportMg, convertToVideo,
    innerW, visibleWindow, rowHeightOf, tracksHeight,
    majorFrames, minorFrames, minorTicksPerMajor, rulerSpanFrames,
    frameFromClientX, trackFromClientY, copyCaptionSelections, pasteCaptionClipboard,
    pointer, drag, marquee, pickDrag, startPick, onPointerMove, onPointerUp, onPointerCancel,
    activeSelectionMovePreview, libDropTarget, setLibDropTarget,
    applyLibraryToClip, applyLibraryToTrack, seekTo,
    clearHoverPreview, updateHoverPreview, startSeekGesture, updateSeekGesture, finishSeekGesture,
    markers, zoneIn, zoneOut, editing, editMarker, setEditMarker, pinnedItemIds,
  } = useTimelineController(props);

  return (
    <section
      className="cc-timeline"
      data-cc-shortcut-surface="timeline"
      tabIndex={-1}
      onPointerDownCapture={(event) => {
        if (!(event.target as HTMLElement).closest('button, input, select, textarea, [contenteditable="true"]')) {
          event.currentTarget.focus({ preventScroll: true });
        }
        const target = event.target as HTMLElement;
        if (!target.closest(CAPTION_SELECTION_OWNER_SELECTOR)
          && shouldClearCaptionSelectionFromPointer({
            insideTimelineClip: !!target.closest(CAPTION_SELECTION_TIMELINE_CLIP_SELECTOR),
            insideTimelineBlank: !!target.closest(CAPTION_SELECTION_TIMELINE_REGION_SELECTOR),
            insideTimelineHead: !!target.closest(CAPTION_SELECTION_TIMELINE_HEAD_SELECTOR),
            additive: event.metaKey || event.ctrlKey,
          })) {
          onSelectCaption(null);
        }
      }}
      style={{ flex: 1, borderLeft: `0.5px solid ${theme.border}`, background: theme.bg, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', position: 'relative' }}
    >
      {/* marker note editor (click a pin → note popup) */}
      {editing && <MarkerEditor editing={editing} fps={state.fps} commands={commands} onClose={() => setEditMarker(null)} />}
      <TimelineToolbar
        state={state} commands={commands}
        editMode={editMode}
        placeMode={placeMode} setPlaceMode={setPlaceMode}
        snapping={snapping}
        recorder={recorder} canRecord={!!onRecordVoiceover}
        playing={playing}
        timecodeRef={toolbarTimecodeRef} playheadFrame={playheadRef.current} total={total}
        captionsVisible={captionsVisible}
        zoom={zoom} setZoom={setZoom}
      />

      {/* selection-mode hint strip (subtle banner while picking refs) */}
      {pickMode && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 12px', fontSize: 11, color: theme.accent, borderBottom: `0.5px solid ${theme.border}`, background: theme.panelAlt, flexShrink: 0 }}>
          <Icon name="cursor" size={12} />
          {t('选择模式：点片段引用 · 拖过标尺/空白选时间段 · 单击标尺打时间点 — 引用会加进聊天输入框')}
        </div>
      )}

      {/* scrollable ruler + tracks (playhead spans both). Ctrl/⌘+wheel = time
          zoom at cursor, Alt+wheel = track-height zoom (native listener above). */}
      <div ref={scrollRef} style={{ overflow: 'auto', flex: 1, minHeight: 0 }}
        onPointerDownCapture={startSeekGesture}
        onPointerMoveCapture={(event) => { updateSeekGesture(event); updateHoverPreview(event); }}
        onPointerUpCapture={finishSeekGesture}
        onPointerCancelCapture={(event) => {
          if (seekGestureRef.current?.pointerId === event.pointerId) seekGestureRef.current = null;
          clearHoverPreview();
        }}
        onPointerLeave={clearHoverPreview}
        onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}
        title={t('Ctrl/⌘+滚轮 缩放时间轴 · Alt+滚轮 缩放轨道高度')}>
        <div ref={innerRef} style={{ position: 'relative', width: innerW }}>
          {/* ruler (click to seek, hold to scrub; selection mode: click = timepoint, drag = timerange).
The playhead line/triangle is pointerEvents:none, click it to click the ruler - scrub the same path to take effect.*/}
          <TimelineRuler
            state={state} empty={empty} px={px}
            majorFrames={majorFrames} minorFrames={minorFrames} minorTicksPerMajor={minorTicksPerMajor}
            rulerEndFrame={rulerSpanFrames} visibleWindow={visibleWindow}
            pickMode={pickMode} startPick={startPick} seekTo={seekTo}
            rulerTimecodeRef={rulerTimecodeRef} playheadFrame={playheadRef.current}
            zoneIn={zoneIn} zoneOut={zoneOut} markers={markers} onEditMarker={setEditMarker}
            pinnedMarkerId={editMarker}
          />

          {/* tracks */}
          {trackIds.map((trackId) => {
            const meta = metaOf(trackId);
            const alias = trackAlias(state, trackId);
            const config = state.tracks?.[trackId] ?? {};
            const trackCaptions = meta.kind === 'caption' ? captionsOnTrack(state, trackId) : null;
            const dragIsAudio = drag ? indexes.itemById.get(drag.id)?.kind === 'audio' : false;
            const isDropTarget = drag?.mode === 'move' && drag.targetTrack === trackId && meta.kind === (dragIsAudio ? 'audio' : 'video') && !state.tracks?.[trackId]?.locked;
            const hidden = meta.kind === 'caption' ? !trackCaptions?.enabled : config.hidden ?? false;
            const headConfig = meta.kind === 'caption' ? { ...config, hidden } : config;
            const locked = config.locked ?? false;
            const kindLabel = meta.kind === 'video' ? '视频' : meta.kind === 'audio' ? '音乐' : '字幕';
            // Stable title (类型+序号) plus optional custom name as a second row,
            // so track naming never drifts when AI creates tracks with its own labels.
            const titleName = locale === 'en' ? alias : `${t(kindLabel)}${alias.slice(1)}`;
            const customName = config.name || undefined;
            const deletePlan = trackDeletePlan(state, trackId);
            return (
              <div key={trackId} className="cc-track-row" style={{ height: rowHeightOf(trackId), background: isDropTarget ? `color-mix(in srgb, ${theme.success} 15%, ${theme.bg})` : undefined }}>
                <TrackHead
                  trackId={trackId} kind={meta.kind} trackName={titleName} customName={customName} config={headConfig}
                  deleteBlockedReason={deletePlan.blockedReason}
                  onDelete={() => {
                    if (deletePlan.requiresConfirmation
                      && !window.confirm(t('删除轨道会同时删除其中的片段、字幕和转场，确认继续吗？'))) return;
                    if (deletePlan.actions.length) commands.batch(deletePlan.actions, t('删除轨道'));
                  }}
                  menuElevated={captionMenu?.id === trackId || duckMenu?.id === trackId}
                  width={HEADER_W} commands={commands}
                  onToggleCaptions={() => toggleCaptions(trackId)}
                  // Both menus are attached with trigger buttons, top clamping margin = maximum menu height + margin (captions 420, dodge ≈ 300);
                  // When the caption menu is clipped to the left, space should be reserved for the translation submenu that pops to the right (212+4+128)
                  onToggleCaptionMenu={(rect) => {
                    if (captionMenu?.id === trackId) closeTrackDrillMenu();
                    else openCaptionTrackMenu(trackId, rect);
                  }}
                  onToggleDuckMenu={(rect) => {
                    if (duckMenu?.id === trackId) closeTrackDrillMenu();
                    else openDuckTrackMenu(trackId, rect);
                  }}
                  duckMenuPos={duckMenu?.id === trackId ? duckMenu : null}
                  onCloseDuckMenu={closeTrackDrillMenu}
                  onBackDuckMenu={backFromTrackDrillMenu}
                >
                  {captionMenu?.id === trackId && (
                    <CaptionStyleMenu
                      state={state} commands={commands} trackId={trackId} pos={captionMenu}
                      error={captionError} onError={setCaptionError} onClose={closeTrackDrillMenu}
                      onBack={backFromTrackDrillMenu}
                      initialTranslateOpen={captionMenu.translate}
                    />
                  )}
                </TrackHead>
                {meta.kind === 'caption' ? <CaptionTrackLane state={state} captions={trackCaptions} trackId={trackId}
                  playheadFrame={playheadRef.current} px={px} rowHeight={rowHeightOf(trackId)} locked={locked} hidden={hidden} snapping={snapping}
                  trackFromClientY={trackFromClientY}
                  selectedCaptions={selectedCaptions} selectedItemIds={selectedIdsOf(state)}
                  selectionMovePreview={activeSelectionMovePreview}
                  onSelectCaption={onSelectCaption}
                  onSelectionMovePreview={setCaptionSelectionMovePreview}
                  onMoveTimelineSelection={commitTimelineSelectionMove}
                  onUpdate={(patch) => commands.updateCaptions(patch, trackId)}
                  onMove={(move) => moveCaptionCue(trackId, move)}
                  onDropExternalFiles={onDropExternalFiles}
                  frameFromClientX={frameFromClientX}
                  isOverChatComposer={(clientX, clientY) => {
                    const composer = document.querySelector<HTMLElement>('[data-cc-chat-composer]');
                    return composer ? isTimelineDragOverChat(clientX, clientY, composer.getBoundingClientRect()) : false;
                  }}
                  onAddSelectionToChat={(selection) => {
                    const itemsById = new Map(state.items.map((item) => [item.id, item]));
                    addSelectionToChat({
                      items: selection.itemIds.flatMap((id) => {
                        const item = itemsById.get(id);
                        return item ? [item] : [];
                      }),
                      captions: selection.captionSelections,
                    });
                  }}
                  onTrackContextMenu={(menu) => {
                    setCtxMenu(null);
                    setCaptionMenu(null);
                    setDuckMenu(null);
                    setTrackMenu(menu);
                  }}
                  onCopyCue={() => { copyCaptionSelections(); }}
                  onPasteCue={pasteCaptionClipboard}
                  onDelete={(laneId, index) => trackCaptions && commands.updateCaptions(removeManualCue(trackCaptions, laneId, index), trackId)} /> : <TrackLane
                  trackId={trackId} indexes={indexes} state={state} commands={commands} pointer={pointer}
                  editMode={editMode} pickMode={pickMode} locked={locked} hidden={hidden} muted={config.muted ?? false}
                  px={px} rowHeight={rowHeightOf(trackId)} visibleWindow={visibleWindow}
                  pinnedItemIds={pinnedItemIds}
                  selectionMovePreview={captionSelectionMovePreview}
                  libDropTarget={libDropTarget} setLibDropTarget={setLibDropTarget}
                  applyLibraryToClip={applyLibraryToClip} applyLibraryToTrack={applyLibraryToTrack}
                  rippleOnDrop={placeMode === 'insert'}
                  overwriteOnDrop={placeMode === 'overwrite'}
                  onDropExternalFiles={onDropExternalFiles}
                  frameFromClientX={frameFromClientX} onContextMenu={(menu) => { setTrackMenu(null); setCtxMenu(menu); }}
                  onTrackContextMenu={(menu) => {
                    setCtxMenu(null);
                    setCaptionMenu(null);
                    setDuckMenu(null);
                    setTrackMenu(menu);
                  }} scrollRef={scrollRef}
                />}
              </div>
            );
          })}

          {/* snap guide — appears while a drag edge is locked onto a target */}
          {drag && drag.snapAt !== null && (
            <div className="cc-snap-guide" style={{ position: 'absolute', top: 0, left: HEADER_W + drag.snapAt * px, height: RULER_H + tracksHeight }} />
          )}

          {hoverPreviewFrame !== null && (
            <div
              aria-hidden
              className="cc-timeline-hover-guide"
              style={{ left: HEADER_W + hoverPreviewFrame * px, height: RULER_H + tracksHeight }}
            />
          )}

          {/* selection-mode timerange marquee (time-marked drag) */}
          {pickDrag && Math.abs(pickDrag.endFrame - pickDrag.startFrame) > 0 && (
            <div style={{
              position: 'absolute', top: 0,
              left: HEADER_W + Math.min(pickDrag.startFrame, pickDrag.endFrame) * px,
              width: Math.abs(pickDrag.endFrame - pickDrag.startFrame) * px,
              height: RULER_H + tracksHeight,
              background: 'rgba(88,166,255,0.14)', borderLeft: '0.5px solid #58a6ff', borderRight: '0.5px solid #58a6ff',
              pointerEvents: 'none', zIndex: 5,
            }} />
          )}

          {/* playhead — GPU layer + rAF-coalesced updates for smoother scrub/play */}
          <div
            ref={playheadLineRef}
            className="cc-playhead"
            style={{
              position: 'absolute', top: 0, left: 0,
              transform: `translate3d(${HEADER_W + playheadRef.current * px}px,0,0)`,
              height: RULER_H + tracksHeight,
              pointerEvents: 'none',
              willChange: 'transform',
              zIndex: 30,
            }}
          >
            <div className="cc-playhead-handle" style={{ transform: 'translateX(-6px)', width: 13, height: 11, clipPath: 'polygon(0 0, 100% 0, 50% 100%)' }} />
          </div>
        </div>
      </div>

      {/* rubber-band selection rect (client/fixed so it tracks the pointer while scrolling) */}
      {marquee && (() => {
        const left = Math.min(marquee.x0, marquee.x1);
        const top = Math.min(marquee.y0, marquee.y1);
        const w = Math.abs(marquee.x1 - marquee.x0);
        const h = Math.abs(marquee.y1 - marquee.y0);
        if (w < 2 && h < 2) return null;
        return (
          <div
            aria-hidden
            style={{
              position: 'fixed',
              left, top, width: w, height: h,
              border: '1px solid rgba(120, 170, 255, 0.95)',
              background: 'rgba(80, 140, 255, 0.16)',
              borderRadius: 2,
              pointerEvents: 'none',
              zIndex: 80,
              boxSizing: 'border-box',
            }}
          />
        );
      })()}

      <input
        ref={relinkInputRef}
        type="file"
        accept="video/*,audio/*,image/*,.gif,.svg"
        hidden
        onChange={(event) => { void relinkFile(event.currentTarget.files); }}
      />
      <input
        ref={trackInsertInputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => insertTrackFiles(event.currentTarget.files)}
      />

      {/* blank-track right-click menu */}
      {trackMenu && (() => {
        const trackId = trackMenu.trackId;
        if (!trackIds.includes(trackId)) return null;
        const kind = trackKind(state, trackId);
        const config = state.tracks?.[trackId] ?? {};
        const captions = kind === 'caption' ? captionsOnTrack(state, trackId) : null;
        const items = state.items.filter((item) => item.track === trackId);
        const captionSelections = captions
          ? captionSelectionsInFrameRange(trackId, captions, state.items, state.fps, 0, Number.MAX_SAFE_INTEGER)
          : [];
        const sortedItems = [...items].sort((a, b) => a.startFrame - b.startFrame);
        const captionTighten = captions ? closeCaptionTrackGaps(captions) : null;
        const canTighten = kind === 'caption'
          ? !!captionTighten?.changed
          : sortedItems.some((item, index) => index > 0
            && item.startFrame > sortedItems[index - 1]!.startFrame + sortedItems[index - 1]!.durationInFrames);
        const clearPlan = trackClearPlan(state, trackId);
        const deletePlan = trackDeletePlan(state, trackId);
        const hidden = kind === 'caption' ? !captions?.enabled : !!config.hidden;
        return (
          <TrackContextMenu
            kind={kind}
            x={trackMenu.x}
            y={trackMenu.y}
            hidden={hidden}
            muted={!!config.muted}
            locked={!!config.locked}
            canTighten={canTighten}
            hasContents={clearPlan.hasContents}
            hasSelectable={kind === 'caption' ? captionSelections.length > 0 : items.length > 0}
            deleteBlockedReason={deletePlan.blockedReason}
            onInsert={() => beginTrackInsert(trackId, trackMenu.frame)}
            onTighten={() => {
              if (kind === 'caption' && captionTighten?.changed) commands.setCaptions(captionTighten.captions, trackId);
              else if (kind !== 'caption') commands.tightenTrack(trackId);
            }}
            onSelectAll={() => {
              if (kind === 'caption') {
                commands.selectItems([]);
                onMarqueeCaptionSelect(captionSelections, { additive: false, preserveWithItems: false });
              } else {
                onMarqueeCaptionSelect([], { additive: false, preserveWithItems: false });
                commands.selectItems(items.map((item) => item.id));
              }
            }}
            onClear={() => {
              if (clearPlan.blockedReason || !clearPlan.hasContents) return;
              if (!window.confirm(t('清空轨道会删除其中的片段、字幕和转场，确认继续吗？'))) return;
              commands.batch(clearPlan.actions, t('清空轨道'));
              onMarqueeCaptionSelect([], { additive: false, preserveWithItems: false });
            }}
            onToggleHidden={() => {
              if (kind === 'caption') toggleCaptions(trackId);
              else commands.toggleTrackFlag(trackId, 'hidden');
            }}
            onToggleMuted={() => commands.toggleTrackFlag(trackId, 'muted')}
            onToggleLocked={() => commands.toggleTrackFlag(trackId, 'locked')}
            onRename={() => {
              const current = state.tracks?.[trackId]?.name ?? '';
              const next = window.prompt(t('轨道名称（留空恢复默认）'), current) ?? null;
              if (next === null) return;
              commands.updateTrack(trackId, { name: next.trim() ? next.trim() : undefined });
            }}
            onOpenDuck={(rect) => openDuckTrackMenu(trackId, rect, trackMenu, true)}
            onOpenCaptionStyle={(rect) => openCaptionTrackMenu(trackId, rect, false, trackMenu, true)}
            onOpenTranslate={(rect) => openCaptionTrackMenu(trackId, rect, true, trackMenu, true)}
            onDelete={() => {
              if (deletePlan.blockedReason) return;
              if (deletePlan.requiresConfirmation
                && !window.confirm(t('删除轨道会同时删除其中的片段、字幕和转场，确认继续吗？'))) return;
              commands.batch(deletePlan.actions, t('删除轨道'));
              onMarqueeCaptionSelect([], { additive: false, preserveWithItems: false });
            }}
            onClose={() => setTrackMenu(null)}
          />
        );
      })()}

      {/* clip right-click menu */}
      {ctxMenu && (() => {
        const item = state.items.find((it) => it.id === ctxMenu.id);
        if (!item) return null;
        return (
          <ClipContextMenu item={item} x={ctxMenu.x} y={ctxMenu.y} playhead={playheadRef.current} commands={commands}
            timeline={state}
            selectedIds={selectedIdsOf(state)}
            transitions={(state.transitions ?? []).filter((t) => t.incomingItemId === item.id || t.outgoingItemId === item.id)}
            fxClip={fxClip} onCopyFx={setFxClip} onClose={() => setCtxMenu(null)}
            onExportMg={exportMg} onConvertToVideo={convertToVideo}
            onAddComment={(target, frame, clientX, clientY) => {
              playerRef.current?.seekTo(frame);
              onReviewItem?.({ itemId: target.id, frame, clientX, clientY });
            }}
            onAddToChat={(items) => addSelectionToChat({ items, captions: [] })}
            onRelinkFile={beginRelink} />
        );
      })()}

      {/* single-clip render status (export MG / convert to video take a few seconds)*/}
      {clipJob && (
        <div style={{ position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 200,
          background: clipJob.error ? theme.accent : theme.panelAlt, color: clipJob.error ? theme.onAccent : theme.text,
          border: `0.5px solid ${theme.borderLight}`, borderRadius: 4, padding: '9px 16px', fontSize: 12.5,
          boxShadow: `0 8px 28px ${themeAlpha.shadow(0.5)}`, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span>{clipJob.msg}</span>
          {clipJob.error && <button onClick={() => setClipJob(null)} style={{ background: 'none', border: 'none', color: theme.onAccent, cursor: 'pointer', padding: 0, lineHeight: 0, display: 'grid', placeItems: 'center' }}><Icon name="x" size={14} /></button>}
        </div>
      )}
    </section>
  );
}
