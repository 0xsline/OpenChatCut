import type { RefObject } from 'react';
import { activeEditorState, type ProjectDoc } from '../editor/types';
import type { EditorCommands } from '../editor/store';
import { keyboardPreviewNudgePlan, type PreviewNudgeDirection } from '../components/preview/previewTransform';
import { saveVersion } from '../persist/versionStore';
import type { TimelineShortcutApi } from './timelineApi';
import type { ActionBindings } from './useActionBindings';
import { useActionBindings } from './useActionBindings';
import { useShortcutDispatcher } from './useShortcutDispatcher';

interface EditorActionDeps {
  commands: EditorCommands;
  docRef: RefObject<ProjectDoc>;
  fps: number;
  projectId: string;
  timelineRef: RefObject<TimelineShortcutApi | null>;
  openExport: () => void;
  openDesign: () => void;
  openHistory: () => void;
  openShortcuts: () => void;
  toggleLayout: () => void;
  focusAgent: () => void;
  selectAll: () => void;
}

const timeline = (ref: RefObject<TimelineShortcutApi | null>) => ref.current;

function previewCanvasHasKeyboardFocus(): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  return active instanceof HTMLElement && !!active.closest('.cc-preview-transform-overlay');
}

function nudgeSelectedPreview(deps: EditorActionDeps, direction: PreviewNudgeDirection): boolean {
  if (!previewCanvasHasKeyboardFocus()) return false;
  const state = activeEditorState(deps.docRef.current);
  const item = state.selectedId ? state.items.find((candidate) => candidate.id === state.selectedId) : null;
  if (!item || state.tracks?.[item.track]?.locked || state.tracks?.[item.track]?.hidden) return false;
  const plan = keyboardPreviewNudgePlan(
    item,
    timeline(deps.timelineRef)?.getPlayhead() ?? item.startFrame,
    direction,
  );
  if (!plan) return false;
  if ('transform' in plan) deps.commands.setItemTransform(plan.itemId, plan.transform);
  else deps.commands.setItemKeyframe(plan.itemId, plan.keyframe.prop, plan.keyframe.localFrame, plan.keyframe.value);
  return true;
}

function playbackActions(deps: EditorActionDeps): ActionBindings {
  const tl = () => timeline(deps.timelineRef);
  return {
    'play-pause': () => tl()?.playPause(),
    'seek-back': () => {
      if (nudgeSelectedPreview(deps, 'left')) return;
      const api = tl();
      if (api) api.seekTo(api.getPlayhead() - 1);
    },
    'seek-fwd': () => {
      if (nudgeSelectedPreview(deps, 'right')) return;
      const api = tl();
      if (api) api.seekTo(api.getPlayhead() + 1);
    },
    'seek-back-sec': () => { const api = tl(); if (api) api.seekTo(api.getPlayhead() - deps.fps); },
    'seek-fwd-sec': () => { const api = tl(); if (api) api.seekTo(api.getPlayhead() + deps.fps); },
    'shuttle-back': () => tl()?.shuttle(-1),
    'shuttle-fwd': () => tl()?.shuttle(1),
    'shuttle-pause': () => tl()?.shuttle(0),
    'shuttle-jog-back': () => tl()?.shuttleJog(-1),
    'shuttle-jog-fwd': () => tl()?.shuttleJog(1),
  };
}

function editingActions(deps: EditorActionDeps): ActionBindings {
  const tl = () => timeline(deps.timelineRef);
  return {
    undo: () => deps.commands.undo(),
    redo: () => deps.commands.redo(),
    copy: () => tl()?.copySelected(),
    cut: () => tl()?.cutSelected(),
    paste: () => tl()?.pasteClipboard(),
    'paste-effects': () => tl()?.pasteEffects(),
    duplicate: () => tl()?.duplicateSelected(),
    delete: ({ shift }) => tl()?.deleteSelected(shift),
    split: () => tl()?.splitAtPlayhead(),
    'interaction-mode-selection': () => tl()?.setEditMode('selection'),
    'interaction-mode-trim': () => tl()?.setEditMode('trim'),
    'interaction-mode-slip': () => tl()?.setEditMode('slip'),
    'interaction-mode-rate-stretch': () => tl()?.setEditMode('rate-stretch'),
    'interaction-mode-blade': () => tl()?.setEditMode('blade'),
    'interaction-mode-pen': () => tl()?.setEditMode('pen'),
    'nudge-left': ({ shift }) => tl()?.nudgeSelected(-(shift ? 5 : 1)),
    'nudge-right': ({ shift }) => tl()?.nudgeSelected(shift ? 5 : 1),
    'trim-start': () => tl()?.trimSelectedToPlayhead('start'),
    'trim-end': () => tl()?.trimSelectedToPlayhead('end'),
    'select-all': () => deps.selectAll(),
    'select-after': () => tl()?.selectAfterPlayhead(),
    'move-up': () => tl()?.moveSelectedTrack(-1),
    'move-down': () => tl()?.moveSelectedTrack(1),
    'move-left-boundary': () => tl()?.moveSelectedToBoundary('left'),
    'move-right-boundary': () => tl()?.moveSelectedToBoundary('right'),
  };
}

function navigationActions(deps: EditorActionDeps): ActionBindings {
  const tl = () => timeline(deps.timelineRef);
  return {
    'prev-edit': () => {
      if (!nudgeSelectedPreview(deps, 'up')) tl()?.gotoEdit(-1);
    },
    'next-edit': () => {
      if (!nudgeSelectedPreview(deps, 'down')) tl()?.gotoEdit(1);
    },
    'zone-in': () => tl()?.setZoneIn(),
    'zone-out': () => tl()?.setZoneOut(),
    'zone-clear': () => tl()?.clearZone(),
    'zone-clip': () => tl()?.zoneFromClip(),
    'zone-selection': () => tl()?.zoneFromSelection(),
    'marker-add': () => tl()?.addMarker(false),
    'marker-shortcut-add-and-open': () => tl()?.addMarker(true),
    'marker-modify-at-playhead': () => tl()?.modifyMarkerAtPlayhead(),
    'marker-delete-at-playhead': () => tl()?.deleteMarkerAtPlayhead(),
    'marker-prev': () => tl()?.gotoMarker(-1),
    'marker-next': () => tl()?.gotoMarker(1),
  };
}

function viewActions(deps: EditorActionDeps): ActionBindings {
  const tl = () => timeline(deps.timelineRef);
  return {
    snapping: () => tl()?.toggleSnap(),
    'selection-mode': () => tl()?.setEditMode('selection'),
    'zoom-in': () => tl()?.zoomBy(1.4),
    'zoom-out': () => tl()?.zoomBy(1 / 1.4),
    'zoom-fit': () => tl()?.fitToView(),
    fullscreen: () => tl()?.fullscreenPreview(),
    'keyboard-shortcuts': () => deps.openShortcuts(),
    'open-export': () => deps.openExport(),
    'open-design': () => deps.openDesign(),
    'open-history': () => deps.openHistory(),
    'toggle-layout': () => deps.toggleLayout(),
    'ask-ai': () => deps.focusAgent(),
  };
}

export function useEditorActions(deps: EditorActionDeps): void {
  const bindings: ActionBindings = {
    ...playbackActions(deps),
    ...editingActions(deps),
    ...navigationActions(deps),
    ...viewActions(deps),
    'save-version': () => {
      const name = `版本 ${new Date().toLocaleString('zh-CN', {
        month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })}`;
      void saveVersion(deps.projectId, name, deps.docRef.current).then(deps.openHistory);
    },
  };
  useActionBindings(bindings);
  useShortcutDispatcher();
}
