import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { analyzeAutoGrade, type AutoGradeResponse } from '../color/autoGrade';
import type { t as translate } from '../i18n/locale';
import { showAppToast } from '../ui/appToast';
import { sourceWindowForTimelineRange } from './sourceLimit';
import type { EditorCommands } from './store';
import type { TimelineItem, TimelineState } from './types';
import { selectedIdsOf } from './types';

type Translate = typeof translate;

interface AutoGradeRecommendation {
  itemId: string;
  itemName: string;
  analysis: AutoGradeResponse;
}

interface AutoGradeSession {
  recommendations: AutoGradeRecommendation[];
  failedCount: number;
}

interface UseEditorAutoGradeOptions {
  state: TimelineState;
  stateRef: MutableRefObject<TimelineState>;
  commands: EditorCommands;
  projectId: string;
  t: Translate;
  setPreviewState: Dispatch<SetStateAction<TimelineState | null>>;
}
interface AutoGradeController {
  busy: boolean;
  setBusy: Dispatch<SetStateAction<boolean>>;
  session: AutoGradeSession | null;
  setSession: Dispatch<SetStateAction<AutoGradeSession | null>>;
  requestRef: MutableRefObject<number>;
  cancel: () => void;
}

function isAutoGradeTarget(item: TimelineItem, state: TimelineState): boolean {
  if (item.kind !== 'video' && item.kind !== 'image' && item.kind !== 'gif') return false;
  if (state.tracks?.[item.track]?.locked) return false;
  return /^\/media\/uploads\/[^/]+(?:\?.*)?$/.test(item.src ?? '');
}

function autoGradeTargetsOf(state: TimelineState): TimelineItem[] {
  const selected = new Set(selectedIdsOf(state));
  return state.items.filter((item) => selected.has(item.id) && isAutoGradeTarget(item, state));
}

async function collectRecommendations(
  snapshot: TimelineState,
  targets: TimelineItem[],
  isCurrent: () => boolean,
): Promise<{ recommendations: AutoGradeRecommendation[]; firstError: unknown } | null> {
  const recommendations: AutoGradeRecommendation[] = [];
  const cache = new Map<string, Promise<AutoGradeResponse>>();
  let firstError: unknown = null;
  for (const item of targets) {
    if (!isCurrent()) return null;
    const sourceWindow = sourceWindowForTimelineRange(item, 0, item.durationInFrames);
    const startSeconds = sourceWindow.startFrame / snapshot.fps;
    const durationSeconds = Math.max(1 / snapshot.fps, (sourceWindow.endFrame - sourceWindow.startFrame) / snapshot.fps);
    const cacheKey = `${item.src}\u0000${startSeconds.toFixed(3)}\u0000${durationSeconds.toFixed(3)}`;
    try {
      let pending = cache.get(cacheKey);
      if (!pending) {
        pending = analyzeAutoGrade({ src: item.src!, startSeconds, durationSeconds });
        cache.set(cacheKey, pending);
      }
      recommendations.push({ itemId: item.id, itemName: item.name, analysis: await pending });
    } catch (error) {
      firstError ??= error;
    }
  }
  return isCurrent() ? { recommendations, firstError } : null;
}

function useAutoGradeController(selectionKey: string, projectId: string): AutoGradeController {
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<AutoGradeSession | null>(null);
  const requestRef = useRef(0);
  useEffect(() => {
    requestRef.current += 1;
    setBusy(false);
    setSession(null);
  }, [selectionKey, projectId]);
  const cancel = useCallback(() => {
    requestRef.current += 1;
    setBusy(false);
    setSession(null);
  }, []);
  return { busy, setBusy, session, setSession, requestRef, cancel };
}

function useAnalyzeSelectedColor(
  options: UseEditorAutoGradeOptions,
  controller: AutoGradeController,
) {
  const { stateRef, setPreviewState, t } = options;
  const { requestRef, setBusy, setSession } = controller;
  return useCallback(async () => {
    const snapshot = stateRef.current;
    const targets = autoGradeTargetsOf(snapshot);
    if (!targets.length) {
      showAppToast(t('请选择已导入媒体池的视频、图片或 GIF 片段'), { error: true });
      return;
    }
    const requestId = ++requestRef.current;
    setPreviewState(null);
    setSession(null);
    setBusy(true);
    const result = await collectRecommendations(snapshot, targets, () => requestRef.current === requestId);
    if (!result) return;
    try {
      if (!result.recommendations.length) throw result.firstError ?? new Error(t('未获得可用的校色结果'));
      const failedCount = targets.length - result.recommendations.length;
      setSession({ recommendations: result.recommendations, failedCount });
      showAppToast(failedCount
        ? t('已预览 {n} 个片段，{failed} 个分析失败', { n: result.recommendations.length, failed: failedCount })
        : t('自动校色预览已生成，可确认应用或取消'));
    } catch (error) {
      showAppToast(t('自动校色分析失败：{error}', {
        error: error instanceof Error ? error.message : String(error),
      }), { error: true });
    } finally {
      if (requestRef.current === requestId) setBusy(false);
    }
  }, [requestRef, setBusy, setPreviewState, setSession, stateRef, t]);
}

function useApplyAutoGrade(
  session: AutoGradeSession | null,
  setSession: Dispatch<SetStateAction<AutoGradeSession | null>>,
  commands: EditorCommands,
  t: Translate,
) {
  return useCallback(() => {
    if (!session?.recommendations.length) return;
    commands.batch(session.recommendations.map((recommendation) => ({
      type: 'setFilters' as const,
      id: recommendation.itemId,
      patch: recommendation.analysis.filters,
    })), 'Apply automatic color correction');
    const applied = session.recommendations.length;
    setSession(null);
    showAppToast(t('已将自动校色应用到 {n} 个片段', { n: applied }));
  }, [session, commands, setSession, t]);
}

function previewStateFor(state: TimelineState, session: AutoGradeSession | null): TimelineState | null {
  if (!session) return null;
  const filters = new Map(session.recommendations.map((entry) => [entry.itemId, entry.analysis.filters]));
  return {
    ...state,
    items: state.items.map((item) => {
      const patch = filters.get(item.id);
      return patch ? { ...item, filters: { ...item.filters, ...patch } } : item;
    }),
  };
}

export function useEditorAutoGrade(options: UseEditorAutoGradeOptions) {
  const { state, commands, projectId, t } = options;
  const selectionKey = selectedIdsOf(state).join('\u0000');
  const controller = useAutoGradeController(selectionKey, projectId);
  const autoGradeTargets = useMemo(() => autoGradeTargetsOf(state), [state]);
  const analyzeSelectedColor = useAnalyzeSelectedColor(options, controller);
  const applyAutoGrade = useApplyAutoGrade(controller.session, controller.setSession, commands, t);
  const autoGradePreviewState = useMemo(
    () => previewStateFor(state, controller.session),
    [controller.session, state],
  );
  const selectedAutoGrade = controller.session?.recommendations.find(
    (entry) => entry.itemId === state.selectedId,
  ) ?? null;
  return {
    autoGradeBusy: controller.busy,
    autoGradeSession: controller.session,
    autoGradeTargets,
    cancelAutoGrade: controller.cancel,
    analyzeSelectedColor,
    applyAutoGrade,
    autoGradePreviewState,
    selectedAutoGrade,
  };
}
