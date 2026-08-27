import { enqueueVisualAnalysis } from '../agent/progress/visual-analysis-jobs';
import { useAutoMusicAnalysis } from '../audio/intelligence/useAutoMusicAnalysis';
import { isolateVoiceOnSrc } from '../audio/isolateVoice';
import { analyzeClipLoudness, gainForTarget } from '../audio/loudness';
import { serializableDefsFor } from '../gl/fx/effects';
import { useT } from '../i18n/locale';
import { importMedia } from '../media/upload';
import { useEditorMediaIngest } from '../media/useEditorMediaIngest';
import { resumeOpenGenerationJobs } from '../persist/jobRegistryStore';
import type { ProjectMeta } from '../persist/projectStoreCoordinators';
import { showAppToast } from '../ui/appToast';
import { clipCropInsetPatch } from './clipCrop';
import { isBackgroundFillEligible } from './backgroundFill';
import type { EditorWorkspaceViewProps } from './EditorWorkspaceView';
import { planInspectorBatch } from './inspectorBatch';
import { supportsKeyframeProperty } from './keyframeRegistry';
import { keyframeResetBatch } from './keyframeReset';
import { captureTimelineItemSource, validateTimelineItemSourceBatch } from './mediaSourceRevision';
import { useEditor } from './store';
import type { ProjectDoc } from './types';
import { useEditorAgentEnvironment } from './useEditorAgentEnvironment';
import { useEditorAutoGrade } from './useEditorAutoGrade';
import { useEditorProjectPersistence } from './useEditorProjectPersistence';
import { useEditorSelectionState } from './useEditorSelectionState';
import {
  useEditorWorkspaceDialogs,
  useEditorWorkspaceExportActions,
  useEditorWorkspacePanels,
} from './useEditorWorkspaceUi';

export interface EditorProps {
  initial: ProjectDoc;
  project: ProjectMeta;
  onHome: () => void;
  onRename: (name: string) => void;
}

function useEditorBaseStage({ initial, project }: EditorProps) {
  const t = useT();
  const editor = useEditor(initial);
  useAutoMusicAnalysis(editor.doc.assets);
  const selection = useEditorSelectionState(editor.state, editor.doc, editor.commands, project.id);
  return { ...editor, selection, t };
}

function useEditorEnvironmentStage(props: EditorProps, base: BaseStage) {
  const agent = useEditorAgentEnvironment({
    state: base.state,
    doc: base.doc,
    commands: base.commands,
    projectId: props.project.id,
    selectedItemId: base.selection.selectedItem?.id,
    selectedTransitionId: base.selection.selectedTransition?.id,
    getUndoTarget: base.getUndoTarget,
    getRedoTarget: base.getRedoTarget,
    onRename: props.onRename,
    translate: base.t,
  });
  const autoGrade = useEditorAutoGrade({
    state: base.state,
    stateRef: agent.stateRef,
    commands: base.commands,
    projectId: props.project.id,
    t: base.t,
    setPreviewState: agent.setPreviewState,
  });
  return { agent, autoGrade };
}

function useEditorUiStage(props: EditorProps, base: BaseStage, environment: EnvironmentStage) {
  const { state, doc, commands, selection, t } = base;
  const { agent } = environment;
  const dialogs = useEditorWorkspaceDialogs({ projectId: props.project.id, doc, playerRef: agent.playerRef });
  const persistence = useEditorProjectPersistence({
    projectId: props.project.id, doc, commands, stateRef: agent.stateRef, docRef: agent.docRef,
    playerRef: agent.playerRef, flushBeforeLeaveRef: agent.flushBeforeLeaveRef, onHome: props.onHome,
  });
  const panels = useEditorWorkspacePanels({ commands });
  const ingest = useEditorMediaIngest({
    commands, projectId: props.project.id, assets: doc.assets, stateRef: agent.stateRef,
    docRef: agent.docRef, getPlayhead: dialogs.getPlayhead, setChatCollapsed: panels.setChatCollapsed,
    setChatSeed: dialogs.setChatSeed, t,
  });
  const exportActions = useEditorWorkspaceExportActions({
    commands, docRef: agent.docRef, fps: state.fps, projectId: props.project.id, t,
    shortcutApiRef: dialogs.shortcutApiRef, setShowDesign: dialogs.setShowDesign,
    setShowVersions: dialogs.setShowVersions, setShowShortcuts: dialogs.setShowShortcuts,
    setChatCollapsed: panels.setChatCollapsed, selectAllTimelineContent: selection.selectAllTimelineContent,
  });
  return { dialogs, persistence, panels, ingest, exportActions };
}

type BaseStage = ReturnType<typeof useEditorBaseStage>;
type EnvironmentStage = ReturnType<typeof useEditorEnvironmentStage>;
type UiStage = ReturnType<typeof useEditorUiStage>;

function buildEditorWorkspaceViewProps(
  props: EditorProps,
  base: BaseStage,
  environment: EnvironmentStage,
  ui: UiStage,
): EditorWorkspaceViewProps {
  const { project, onRename } = props;
  const { state, doc, commands, canUndo, canRedo, selection, t } = base;
  const { activeSlipPreview, captionSelection, captionSelections, captionTracks, reviewRequest, selectCaption, selectMarqueeCaptions, selectedCaption, selectedIds, selectedItem, selectedItems, selectedSlipPlan, selectedTransition, sequenceOptions, setActiveSlipPreview, setReviewRequest, setTimelineHoverPreviewFrame, timelineHoverPreviewFrame, trackOptions, usedAssetIds } = selection;
  const { historyGesture, stateRef, applyInspectorSelection, docRef, offlineSrcs, offlineAssetIds, markOffline: markMediaOffline, creativeMode, changeCreativeMode, playerRef, selectedPreviewStatuses, handleSelectedPreviewStatus, allTemplates, agentCtx, previewState, setPreviewState } = environment.agent;
  const { autoGradeBusy, autoGradeSession, autoGradeTargets, cancelAutoGrade, analyzeSelectedColor, applyAutoGrade, autoGradePreviewState, selectedAutoGrade } = environment.autoGrade;
  const { chatSeed, setChatSeed, showDesign, setShowDesign, showVersions, setShowVersions, showShortcuts, setShowShortcuts, showSettings, setShowSettings, shortcutApiRef, getPlayhead } = ui.dialogs;
  const { handleHome } = ui.persistence;
  const { chatCollapsed, setChatCollapsed, panelLayout, inspectorCollapsed, setInspectorCollapsed, addTemplate } = ui.panels;
  const { startAssetTranscription, ingestToPool, importMobileUpload, importToPool, dropExternalFilesToTimeline, addMediaAssetsToTimeline, importToCanvas, pasteMediaAssets, useMediaAI, useTemplateAI } = ui.ingest;
  const { exportJobs, activeExportJobs, exportOpen, setExportOpen, relinkMediaAsset } = ui.exportActions;
  return {
    gridTemplateColumns: panelLayout.gridTemplateColumns,
    gridTemplateRows: panelLayout.gridTemplateRows,
    topBar: { projectId: project.id, projectName: project.name, exporting: activeExportJobs > 0, exportJobCount: activeExportJobs, canUndo, canRedo, onHome: handleHome, onRename, onResumeGeneration: () => resumeOpenGenerationJobs(project.id, { getState: () => stateRef.current, onAsset: (asset) => { if ((docRef.current.assets ?? []).some((item) => item.id === asset.id || item.src === asset.src)) return; commands.addAsset(asset); if (asset.kind !== 'audio') enqueueVisualAnalysis(asset); }, timeoutSeconds: 180 }).then(() => undefined) },
    exportDialog: exportOpen ? { state, project: doc, projectId: project.id, projectName: project.name, exportJobs, onClose: () => setExportOpen(false) } : null,
    designStylePanel: showDesign ? { style: doc.designStyle, onApply: commands.setDesignStyle, onClose: () => setShowDesign(false) } : null,
    versionHistory: showVersions ? { projectId: project.id, currentDoc: doc, onRestore: (d) => { commands.applyDoc(d); setShowVersions(false); }, onClose: () => setShowVersions(false) } : null,
    shortcutsDialog: showShortcuts ? { onClose: () => setShowShortcuts(false) } : null,
    settingsDialog: showSettings ? { onClose: () => setShowSettings(false) } : null,
    chatPanel: { ctx: agentCtx, projectId: project.id, collapsed: chatCollapsed, onToggleCollapse: () => setChatCollapsed((v) => !v), onPreviewState: setPreviewState, seed: chatSeed, creativeMode, onCreativeModeChange: changeCreativeMode, onImportMedia: importToPool, onOpenSettings: () => setShowSettings(true) },
    chatCollapsed,
    onResizeChat: panelLayout.resizeChat,
    libraryPanel: { semanticScopeId: project.id, templates: allTemplates, onAddTemplate: addTemplate, onAddAudio: (a) => commands.addAudio(a), playerRef, fps: state.fps, items: state.items, trackOptions, captionTracks, onSetCaptions: commands.setCaptions, onUpdateCaptions: commands.updateCaptions, onSetItemTranscript: commands.setItemTranscript, onToggleWord: commands.toggleWord, onCleanScript: commands.cleanScript, onSetGapCap: commands.setGapCap, onSetTranscriptPlayOrder: commands.setTranscriptPlayOrder, onReorderTrackItems: commands.reorderTrackItems, onClearEdits: commands.clearEdits, assets: state.assets ?? [], mediaFolders: doc.mediaFolders, usedAssetIds, offlineAssetIds, onAssetLoadError: (asset) => markMediaOffline(asset.src), onImportMedia: importToPool, onImportMobileMedia: importMobileUpload, onIngestDirectoryAsset: ingestToPool, onTranscribeAsset: startAssetTranscription, onAddMediaItem: (asset) => commands.addMediaItem(asset), onAddMediaAssetsToTimeline: addMediaAssetsToTimeline, onUseMediaAI: useMediaAI, onPasteMediaAssets: pasteMediaAssets, onCreateMediaFolder: commands.createMediaFolder, onRenameMediaFolder: commands.renameMediaFolder, onDeleteMediaFolder: commands.deleteMediaFolder, onMoveMediaAssets: commands.moveMediaAssets, onRenameMediaAsset: commands.renameMediaAsset, onRenameMediaAssets: commands.renameMediaAssets, onSetMediaAssetFavorite: commands.setMediaAssetFavorite, onSetMediaAssetsFavorite: commands.setMediaAssetsFavorite, onRemoveMediaAsset: commands.removeMediaAsset, onRemoveMediaAssets: commands.removeMediaAssets, onCreateCaptionTrack: commands.createCaptionTrack, sequenceOptions, onAddSequence: (timelineId) => { const result = commands.addSequence(timelineId, { startFrame: getPlayhead() }); if (!result.ok) showAppToast(t(result.error), { error: true }); }, onRelinkMediaAsset: relinkMediaAsset, onAddSolid: () => commands.addSolidItem({ startFrame: getPlayhead() }), creativeMode, onCreativeModeChange: changeCreativeMode, onUseTemplateAI: useTemplateAI, selectedItem, onApplyTransition: (type, custom) => state.selectedId && commands.addTransition(state.selectedId, type, undefined, custom), onApplyFx: (assetId) => { if (!state.selectedId) return; const it = state.items.find((x) => x.id === state.selectedId); if (!it) return; const prev = it.effects ?? []; const next = [...prev.filter((e) => e.assetId !== assetId), { id: `fx_${assetId}`, assetId, overrides: {} }]; commands.setItemEffects(state.selectedId, next, serializableDefsFor(next)); }, onApplyZoom: (zoom) => state.selectedId && commands.setItemZoom(state.selectedId, zoom) },
    onResizeLibrary: panelLayout.resizeLibrary,
    previewPanel: { state: autoGradePreviewState ?? previewState ?? state, project: doc, playerRef, onImport: importToCanvas, hoverPreviewFrame: timelineHoverPreviewFrame, projectId: project.id, timelineId: doc.activeTimelineId, reviewState: state, selectedItem, reviewRequest, offlineSrcs, onUpdateCaptions: previewState || autoGradePreviewState ? undefined : commands.updateCaptions, onSelectCaption: previewState || autoGradePreviewState ? undefined : selectCaption, activeCaptionSelection: captionSelection, ...(!previewState && !autoGradePreviewState ? { onSelectItem: commands.selectItem, onSetItemTransform: commands.setItemTransform, onSetItemKeyframe: commands.setItemKeyframe, onBeginHistoryGesture: commands.beginHistoryGesture, onEndHistoryGesture: commands.endHistoryGesture, onItemPropChange: (id, key, value) => commands.updateItemProps(id, { [key]: value }) } : {}), onSeedChat: (text) => setChatSeed({ text, nonce: Date.now() }), inspectorOpen: !!(selectedItem || selectedCaption) && !inspectorCollapsed, selectedPreviewStatuses, onSelectedPreviewStatus: handleSelectedPreviewStatus, slipPreview: activeSlipPreview, onToggleInspector: () => setInspectorCollapsed((collapsed) => !collapsed) },
    inspectorPanel: (selectedItem || selectedCaption) && !inspectorCollapsed ? { playerRef, historyGesture, templates: allTemplates, selectedItem, selectedCaption, onCaptionUpdate: (patch) => selectedCaption && commands.updateCaptions(patch, selectedCaption.trackId), selectedIds, selectedItems, fps: state.fps, canvasWidth: state.width, canvasHeight: state.height, collapsed: inspectorCollapsed, onCollapsedChange: setInspectorCollapsed, onItemPropChange: (key, value) => applyInspectorSelection((item) => ({ type: 'updateProps', id: item.id, patch: { [key]: value } }), (item) => selectedItem ? item.kind === selectedItem.kind : false), onItemVolumeChange: (volume) => applyInspectorSelection((item) => ({ type: 'setVolume', id: item.id, volume }), (item) => item.kind === 'audio' || item.kind === 'video'), onItemFadeChange: (fade) => applyInspectorSelection((item) => ({ type: 'setFade', id: item.id, ...fade })), onItemTransformChange: (patch) => applyInspectorSelection((item) => ({ type: 'setTransform', id: item.id, patch }), (item) => item.kind !== 'audio'), onItemCropChange: (edge, value) => applyInspectorSelection((item) => ({ type: 'setTransform', id: item.id, patch: clipCropInsetPatch(item.transform?.crop, edge, value) }), (item) => item.kind !== 'audio'), onItemFiltersChange: (patch) => { if (autoGradeBusy || autoGradeSession) cancelAutoGrade(); applyInspectorSelection((item) => ({ type: 'setFilters', id: item.id, patch }), (item) => item.kind !== 'audio'); }, backgroundFillAvailable: selectedItems.length > 0 && selectedItems.every((item) => isBackgroundFillEligible(state, item)), onItemBackgroundFillChange: (enabled, strength) => applyInspectorSelection((item) => ({ type: 'setBackgroundFill', id: item.id, enabled, strength }), (item) => isBackgroundFillEligible(state, item)), onApplyBackgroundFillToAll: (strength: number) => { const snapshot = stateRef.current; const actions = snapshot.items.filter((item) => isBackgroundFillEligible(snapshot, item)).map((item) => ({ type: 'setBackgroundFill' as const, id: item.id, enabled: true, strength })); if (actions.length === 0) return; commands.batch(actions, 'Apply background fill to all'); showAppToast(t('已将背景填充应用到 {n} 个片段', { n: actions.length })); }, autoGrade: { busy: autoGradeBusy, targetCount: autoGradeTargets.length, previewCount: autoGradeSession?.recommendations.length ?? 0, failedCount: autoGradeSession?.failedCount ?? 0, selectedPreview: selectedAutoGrade ? { filters: selectedAutoGrade.analysis.filters, bitDepth: selectedAutoGrade.analysis.profile.bitDepth, hdr: selectedAutoGrade.analysis.profile.hdr } : null, onAnalyze: analyzeSelectedColor, onApply: applyAutoGrade, onCancel: cancelAutoGrade }, onItemZoomChange: (patch) => applyInspectorSelection((item) => ({ type: 'setZoom', id: item.id, patch }), (item) => item.kind !== 'audio'), onItemEffectsChange: (effects) => { const defs = serializableDefsFor(effects); applyInspectorSelection((item) => ({ type: 'setEffects', id: item.id, effects, defs }), (item) => item.kind === 'video' || item.kind === 'image'); }, selectedPreviewStatuses, onItemSpeedChange: (rate) => applyInspectorSelection((item) => ({ type: 'setSpeed', id: item.id, rate }), (item) => item.kind === 'video' || item.kind === 'audio'), slipPlan: selectedSlipPlan, onItemSlip: selectedSlipPlan && selectedItem ? (deltaInFrames) => commands.slipItem(selectedItem.id, deltaInFrames) : undefined, onNormalizeLoudness: async () => { const ids = [...selectedIds]; const items = [...selectedItems]; if (!items.length || items.some((item) => item.kind !== 'audio' || !item.src)) return; try { const gains = await Promise.all(items.map(async (item) => [item.id, gainForTarget(await analyzeClipLoudness(item.src!), -14)] as const)); const gainById = new Map(gains); const live = stateRef.current; const plan = planInspectorBatch(live, ids, (item) => ({ type: 'setVolume', id: item.id, volume: gainById.get(item.id)! }), (item) => item.kind === 'audio' && gainById.has(item.id)); if (plan.ok) commands.batch(plan.actions, 'Normalize selected loudness'); } catch { showAppToast(t('响度分析失败，未修改任何片段。')); } }, onIsolateVoice: async (action, strength) => { const ids = [...selectedIds]; const items = [...selectedItems]; if (!items.length || items.some((item) => (item.kind !== 'video' && item.kind !== 'audio'))) return; if (action === 'clear') { const plan = planInspectorBatch(stateRef.current, ids, (item) => ({ type: 'setItemDenoise', id: item.id, denoisedSrc: null }), (item) => item.kind === 'video' || item.kind === 'audio'); if (plan.ok) commands.batch(plan.actions, 'Clear selected voice isolation'); return; } if (items.some((item) => !item.src)) return; try { const sourceAssets = docRef.current.assets ?? []; const snapshots = items.map((item) => captureTimelineItemSource(item, sourceAssets)); const isolated = await Promise.all(snapshots.map(async (snapshot, index) => { const item = items[index]!; return [item.id, await isolateVoiceOnSrc(snapshot.src, typeof strength === 'number' ? strength : (item.denoiseStrength ?? 70), { force: true, sourceRevision: snapshot.sourceRevision })] as const; })); const resultById = new Map(isolated); const live = stateRef.current; const validation = validateTimelineItemSourceBatch(snapshots, live.items, docRef.current.assets ?? [], resultById); if (validation.status === 'stale') { showAppToast(t('所选片段的源素材已变化，旧的人声分离结果已丢弃。请重试。'), { error: true }); return; } const plan = planInspectorBatch(live, ids, (item) => { const result = resultById.get(item.id); return result ? { type: 'setItemDenoise' as const, id: item.id, denoisedSrc: result.path, strength: result.strength } : null; }, (item) => (item.kind === 'video' || item.kind === 'audio') && resultById.has(item.id)); if (plan.ok) commands.batch(plan.actions, 'Isolate selected voices'); } catch { showAppToast(t('人声分离失败，未修改任何片段。')); } }, getPlayhead, onSetReframeKeyframe: (frame, fx, fy, mag) => applyInspectorSelection((item) => ({ type: 'reframeKeyframe', id: item.id, frame, focalPointX: fx, focalPointY: fy, magnification: mag }), (item) => item.kind !== 'audio'), onRemoveReframeKeyframe: (frame) => applyInspectorSelection((item) => ({ type: 'removeReframeKeyframe', id: item.id, frame }), (item) => item.kind !== 'audio'), onSetItemKeyframe: (prop, frame, value, easing) => applyInspectorSelection((item) => ({ type: 'setKeyframe', id: item.id, prop, frame, value, easing }), (item) => supportsKeyframeProperty(item, prop)), onRemoveItemKeyframe: (prop, frame) => applyInspectorSelection((item) => ({ type: 'removeKeyframe', id: item.id, prop, frame }), (item) => supportsKeyframeProperty(item, prop)), onResetItemKeyframes: (props) => applyInspectorSelection((item) => keyframeResetBatch(item.id, props).actions, (item) => props.every((prop) => supportsKeyframeProperty(item, prop)), 'Reset selected keyframes'), onSeek: (frame) => shortcutApiRef.current?.seekTo(frame), transition: selectedTransition, onAddTransition: (type) => state.selectedId && commands.addTransition(state.selectedId, type), onSetTransition: (patch) => { const transition = state.transitions?.find((item) => item.incomingItemId === state.selectedId); if (transition) commands.setTransition(transition.id, patch); }, onRemoveTransition: () => { const transition = state.transitions?.find((item) => item.incomingItemId === state.selectedId); if (transition) commands.removeTransition(transition.id); } } : null,
    onResizeTimeline: panelLayout.resizeTimeline,
    timelineTabs: { doc, commands },
    timeline: { state, commands, playerRef, projectId: project.id, shortcutApiRef, selectedCaptions: captionSelections, onSelectCaption: selectCaption, onMarqueeCaptionSelect: selectMarqueeCaptions, onHoverPreviewFrameChange: setTimelineHoverPreviewFrame, onDropExternalFiles: dropExternalFilesToTimeline, onReviewItem: (request) => setReviewRequest({ ...request, nonce: Date.now() }), onSlipPreview: setActiveSlipPreview, onRecordVoiceover: async (blob) => { const ext = blob.type.includes('ogg') ? 'ogg' : 'webm'; const asset = await importMedia(new File([blob], `旁白.${ext}`, { type: blob.type }), state.fps); ingestToPool(asset); commands.addMediaItem(asset, { track: 'A1', startFrame: getPlayhead() }); } },
  };
}

export function useEditorController(props: EditorProps): EditorWorkspaceViewProps {
  const base = useEditorBaseStage(props);
  const environment = useEditorEnvironmentStage(props, base);
  const ui = useEditorUiStage(props, base, environment);
  return buildEditorWorkspaceViewProps(props, base, environment, ui);
}
