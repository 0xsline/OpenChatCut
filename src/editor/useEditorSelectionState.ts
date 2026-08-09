import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import {
  allCaptionSelections,
  captionSelectionKey,
  resolveCaptionSelection,
  type CaptionSelectOptions,
  type CaptionSelectionRef,
} from '../captions/captionSelection';
import { updateCaptionSelections } from '../captions/captionSelectionInteraction';
import { usedMediaAssetIds } from './mediaAssetUsage';
import { selectedInspectorItems } from './inspectorBatch';
import { resolveTimelineRenderPlan, sequenceReferenceError } from './sequenceGraph';
import { planSlip, type SlipPreview } from './slip';
import type { EditorCommands } from './store';
import type { ProjectDoc, Timeline } from './types';
import { captionsOnTrack, selectedIdsOf, timelineTrackIds, trackAlias, trackKind } from './types';

type CaptionSelectionSetter = Dispatch<SetStateAction<CaptionSelectionRef[]>>;
type SelectionCommands = Pick<EditorCommands, 'selectAll' | 'selectItem'>;

export interface EditorReviewRequest {
  itemId: string;
  frame: number;
  clientX: number;
  clientY: number;
  nonce: number;
}

function useCaptionSelectionStorage(state: Timeline, scopeKey: string) {
  const [captionSelections, setCaptionSelections] = useState<CaptionSelectionRef[]>([]);
  const preserveWithItemsRef = useRef(false);
  const scopeRef = useRef(scopeKey);
  const [timelineHoverPreviewFrame, setTimelineHoverPreviewFrame] = useState<number | null>(null);
  const selectedItemIdsKey = selectedIdsOf(state).join('\u0000');

  useEffect(() => {
    const scopeChanged = scopeRef.current !== scopeKey;
    scopeRef.current = scopeKey;
    if (scopeChanged) {
      setCaptionSelections([]);
      preserveWithItemsRef.current = false;
      setTimelineHoverPreviewFrame(null);
      return;
    }
    setCaptionSelections((current) => {
      const valid = current.filter((selection) => resolveCaptionSelection(state, selection));
      return valid.length === current.length ? current : valid;
    });
  }, [scopeKey, state]);

  useEffect(() => {
    if (!state.selectedId) {
      preserveWithItemsRef.current = false;
      return;
    }
    if (preserveWithItemsRef.current) {
      preserveWithItemsRef.current = false;
      return;
    }
    setCaptionSelections([]);
  }, [selectedItemIdsKey, state.selectedId]);

  return {
    captionSelections,
    preserveWithItemsRef,
    setCaptionSelections,
    setTimelineHoverPreviewFrame,
    timelineHoverPreviewFrame,
  };
}

function useSelectCaption(
  commands: SelectionCommands,
  setCaptionSelections: CaptionSelectionSetter,
  preserveWithItemsRef: MutableRefObject<boolean>,
) {
  return useCallback((
    selection: CaptionSelectionRef | null,
    options: CaptionSelectOptions = {},
  ) => {
    if (!selection) {
      setCaptionSelections([]);
      return;
    }
    if (options.additive) {
      preserveWithItemsRef.current = options.preserveWithItems === true;
      setCaptionSelections((current) => updateCaptionSelections(
        current,
        selection,
        options.toggle ? 'toggle' : 'add',
      ));
      return;
    }
    setCaptionSelections([selection]);
    commands.selectItem(null);
  }, [commands, preserveWithItemsRef, setCaptionSelections]);
}

function useSelectAllTimelineContent(
  state: Timeline,
  commands: SelectionCommands,
  setCaptionSelections: CaptionSelectionSetter,
  preserveWithItemsRef: MutableRefObject<boolean>,
) {
  return useCallback(() => {
    const selections = allCaptionSelections(state);
    preserveWithItemsRef.current = selections.length > 0 && state.items.length > 0;
    setCaptionSelections(selections);
    commands.selectAll();
  }, [commands, preserveWithItemsRef, setCaptionSelections, state]);
}

function useSelectMarqueeCaptions(
  captionSelections: CaptionSelectionRef[],
  setCaptionSelections: CaptionSelectionSetter,
  preserveWithItemsRef: MutableRefObject<boolean>,
) {
  return useCallback((
    selections: CaptionSelectionRef[],
    options: { additive: boolean; preserveWithItems: boolean },
  ) => {
    preserveWithItemsRef.current = options.preserveWithItems
      && (selections.length > 0 || (options.additive && captionSelections.length > 0));
    setCaptionSelections((current) => {
      if (!options.additive) return selections;
      const byKey = new Map(current.map((selection) => [captionSelectionKey(selection), selection]));
      for (const selection of selections) byKey.set(captionSelectionKey(selection), selection);
      return [...byKey.values()];
    });
  }, [captionSelections.length, preserveWithItemsRef, setCaptionSelections]);
}

function useCaptionSelectionState(state: Timeline, scopeKey: string, commands: SelectionCommands) {
  const storage = useCaptionSelectionStorage(state, scopeKey);
  const captionSelection = storage.captionSelections.at(-1) ?? null;
  const selectedCaption = useMemo(
    () => resolveCaptionSelection(state, captionSelection),
    [state, captionSelection],
  );
  const selectCaption = useSelectCaption(
    commands,
    storage.setCaptionSelections,
    storage.preserveWithItemsRef,
  );
  const selectAllTimelineContent = useSelectAllTimelineContent(
    state,
    commands,
    storage.setCaptionSelections,
    storage.preserveWithItemsRef,
  );
  const selectMarqueeCaptions = useSelectMarqueeCaptions(
    storage.captionSelections,
    storage.setCaptionSelections,
    storage.preserveWithItemsRef,
  );
  return {
    captionSelection,
    captionSelections: storage.captionSelections,
    selectAllTimelineContent,
    selectCaption,
    selectMarqueeCaptions,
    selectedCaption,
    setTimelineHoverPreviewFrame: storage.setTimelineHoverPreviewFrame,
    timelineHoverPreviewFrame: storage.timelineHoverPreviewFrame,
  };
}

function useSlipSelection(
  state: Timeline,
  selectedItem: Timeline['items'][number] | null,
  selectedItemCount: number,
  projectId: string,
  timelineId: string,
) {
  const [activeSlipPreview, setActiveSlipPreview] = useState<SlipPreview | null>(null);
  const selectedSlipPlan = useMemo(() => {
    if (!selectedItem || selectedItemCount !== 1) return null;
    const result = planSlip(state, selectedItem.id, 0);
    return result.ok ? result : null;
  }, [selectedItem, selectedItemCount, state]);
  useEffect(() => setActiveSlipPreview(null), [projectId, timelineId]);
  return { activeSlipPreview, selectedSlipPlan, setActiveSlipPreview };
}

function useEditorOptions(state: Timeline, doc: ProjectDoc) {
  const trackOptions = useMemo(
    () => timelineTrackIds(state).map((id) => ({
      id,
      alias: trackAlias(state, id),
      name: state.tracks?.[id]?.name,
      kind: trackKind(state, id),
    })),
    [state],
  );
  const captionTracks = trackOptions
    .filter((option) => option.kind === 'caption')
    .map((option) => ({ ...option, captions: captionsOnTrack(state, option.id) }));
  const sequenceOptions = useMemo(() => [...doc.timelines]
    .sort((a, b) => a.order - b.order)
    .map((timeline) => {
      const referenceError = sequenceReferenceError(doc, doc.activeTimelineId, timeline.id);
      return {
        id: timeline.id,
        name: timeline.name,
        durationInFrames: resolveTimelineRenderPlan(doc, timeline.id).durationInFrames,
        disabledReason: referenceError?.message,
      };
    }), [doc]);
  const usedAssetIds = useMemo(() => usedMediaAssetIds(doc), [doc]);
  return { captionTracks, sequenceOptions, trackOptions, usedAssetIds };
}

export function useEditorSelectionState(
  state: Timeline,
  doc: ProjectDoc,
  commands: SelectionCommands,
  projectId: string,
) {
  const selectedItem = state.items.find((item) => item.id === state.selectedId) ?? null;
  const selectedIds = selectedIdsOf(state);
  const selectedItems = selectedInspectorItems(state, selectedIds);
  const selectedTransition = state.transitions
    ?.find((transition) => transition.incomingItemId === state.selectedId) ?? null;
  const scopeKey = `${projectId}\u0000${doc.activeTimelineId}`;
  const captions = useCaptionSelectionState(state, scopeKey, commands);
  const [reviewRequest, setReviewRequest] = useState<EditorReviewRequest | null>(null);
  const slip = useSlipSelection(
    state,
    selectedItem,
    selectedItems.length,
    projectId,
    doc.activeTimelineId,
  );
  const options = useEditorOptions(state, doc);

  return {
    ...captions,
    ...slip,
    ...options,
    reviewRequest,
    selectedIds,
    selectedItem,
    selectedItems,
    selectedTransition,
    setReviewRequest,
  };
}
