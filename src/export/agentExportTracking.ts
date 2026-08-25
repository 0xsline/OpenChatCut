import type { EditorCommands } from '../editor/store';
import type { MediaAsset, ProjectDoc } from '../editor/types';
import { sourceWindowForTimelineRange } from '../editor/sourceLimit';
import { readStoredServerRun } from '../agent/serverRunSessionStorage';
import type { BackgroundExportExecution, ExportJobStore } from './backgroundExportStore';
import { deleteExportJob, pollExport } from './serverExportRenderOperation';
import type { ExportJobResult, Translate } from './exportWorkflowTypes';

export interface AgentExportSourceItem {
  id: string;
  sourceAssetId: string;
  startFrame: number;
  durationInFrames: number;
  srcInFrame?: number;
  playbackRate?: number;
}

export interface AgentExportMediaPoolPlan {
  format: 'video' | 'audio';
  timelineId: string;
  timelineName: string;
  timelineFps: number;
  items: AgentExportSourceItem[];
}

export interface AgentExportSubmission {
  renderId: string;
  projectId: string;
  label: string;
  createdAt: number;
  saveToMediaPool?: AgentExportMediaPoolPlan;
}

export type AgentExportMediaPoolState =
  | { status: 'pending' }
  | { status: 'saved'; mediaAssetId: string; path: string }
  | { status: 'failed'; error: string };

export interface MediaPoolTarget {
  commands: Pick<EditorCommands, 'addAsset'>;
  getDoc: () => ProjectDoc;
}

interface PromotedResult extends ExportJobResult {
  assetId: string;
  path: string;
  name?: string;
}

type SubmissionListener = (submission: AgentExportSubmission) => void;
const listeners = new Set<SubmissionListener>();
const mediaPoolStates = new Map<string, AgentExportMediaPoolState>();
const submissions = new Map<string, AgentExportSubmission>();
const promotedResults = new Map<string, PromotedResult>();

export function notifyAgentExportSubmitted(submission: AgentExportSubmission): void {
  if (submission.saveToMediaPool) {
    submissions.set(submission.renderId, submission);
    mediaPoolStates.set(submission.renderId, { status: 'pending' });
  }
  for (const listener of listeners) listener(submission);
}

export function subscribeAgentExportSubmissions(listener: SubmissionListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function agentExportMediaPoolState(renderId: string): AgentExportMediaPoolState | undefined {
  return mediaPoolStates.get(renderId);
}

export function resetAgentExportTrackingState(): void {
  mediaPoolStates.clear();
  submissions.clear();
  promotedResults.clear();
}

function sourceRanges(plan: AgentExportMediaPoolPlan, completed: ExportJobResult) {
  const from = Math.max(0, Math.round((completed.sourceStartSeconds ?? 0) * plan.timelineFps));
  const duration = Math.max(1, Math.round((completed.durationSeconds ?? 0) * plan.timelineFps));
  const to = from + duration;
  return plan.items.flatMap((item) => {
    const start = Math.max(from, item.startFrame);
    const end = Math.min(to, item.startFrame + item.durationInFrames);
    if (end <= start) return [];
    const window = sourceWindowForTimelineRange(item, start - item.startFrame, end - start);
    return [{
      itemId: item.id,
      sourceAssetId: item.sourceAssetId,
      timelineStartFrame: start,
      timelineEndFrameExclusive: end,
      sourceStartFrame: window.startFrame,
      sourceEndFrameExclusive: window.endFrame,
    }];
  });
}

function mediaAssetFor(
  submission: AgentExportSubmission,
  completed: ExportJobResult,
  promoted: PromotedResult,
  doc: ProjectDoc,
): MediaAsset {
  const plan = submission.saveToMediaPool!;
  const ranges = sourceRanges(plan, completed);
  const name = promoted.name?.trim() || submission.label;
  return {
    id: doc.assets.some((asset) => asset.id === promoted.assetId)
      ? globalThis.crypto.randomUUID()
      : promoted.assetId,
    name,
    sourceFilename: name,
    kind: plan.format,
    src: promoted.path,
    durationInFrames: Math.max(1, Math.round((promoted.durationSeconds ?? completed.durationSeconds ?? 0) * plan.timelineFps)),
    width: promoted.width,
    height: promoted.height,
    props: {
      openchatcutDerivedFrom: {
        kind: 'sequence-export',
        timelineId: plan.timelineId,
        timelineName: plan.timelineName,
        renderId: submission.renderId,
        sourceAssetIds: [...new Set(ranges.map((range) => range.sourceAssetId))],
        sourceRanges: ranges,
      },
    },
  };
}

async function promoteCompletedExport(
  submission: AgentExportSubmission,
): Promise<PromotedResult> {
  const existing = promotedResults.get(submission.renderId);
  if (existing) return existing;
  const response = await fetch(`/export/job/${encodeURIComponent(submission.renderId)}/promote`, { method: 'POST' });
  const promoted = (await response.json().catch(() => null)) as PromotedResult | { error?: string } | null;
  if (!response.ok || !promoted || !('path' in promoted) || !('assetId' in promoted)) {
    const message = promoted && 'error' in promoted ? promoted.error : undefined;
    throw new Error(message ?? `export media promotion failed (${response.status})`);
  }
  promotedResults.set(submission.renderId, promoted);
  return promoted;
}

function registerPromotedExport(
  submission: AgentExportSubmission,
  completed: ExportJobResult,
  promoted: PromotedResult,
  target: MediaPoolTarget,
): void {
  const existing = target.getDoc().assets.find((asset) => asset.src === promoted.path);
  if (existing) {
    mediaPoolStates.set(submission.renderId, { status: 'saved', mediaAssetId: existing.id, path: existing.src });
    return;
  }
  const asset = mediaAssetFor(submission, completed, promoted, target.getDoc());
  target.commands.addAsset(asset);
  mediaPoolStates.set(submission.renderId, { status: 'saved', mediaAssetId: asset.id, path: asset.src });
}

export async function saveTrackedAgentExport(
  renderId: string,
  completed: ExportJobResult,
  target: MediaPoolTarget,
): Promise<void> {
  const submission = submissions.get(renderId);
  if (!submission?.saveToMediaPool) return;
  try {
    const promoted = await promoteCompletedExport(submission);
    registerPromotedExport(submission, completed, promoted, target);
  } catch (error) {
    mediaPoolStates.set(renderId, {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function monitorAgentExport(
  submission: AgentExportSubmission,
  execution: BackgroundExportExecution,
  t: Translate,
  target?: MediaPoolTarget,
): Promise<void> {
  const { signal, setters } = execution;
  setters.setRenderEngine('server');
  try {
    const completed = await pollExport({ setProgress: setters.setProgress, t }, submission.renderId, signal);
    if (submission.saveToMediaPool) {
      try {
        if (!target) throw new Error('media pool target unavailable');
        const promoted = await promoteCompletedExport(submission);
        while (
          readStoredServerRun(submission.projectId)
          && !signal.aborted
        ) await new Promise((resolve) => setTimeout(resolve, 100));
        if (!signal.aborted) {
          registerPromotedExport(submission, completed, promoted, target);
        }
      } catch (error) {
        mediaPoolStates.set(submission.renderId, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
    if (completed.encoder) setters.setEngineInfo(completed.encoder);
    if (completed.encoderFallbackReason) setters.setEngineReason(completed.encoderFallbackReason);
    setters.setProgress((current) => current ? {
      ...current,
      phase: 'completed',
      percent: 100,
      finishedAt: Date.now(),
      outputSize: completed.sizeBytes,
    } : current);
  } finally {
    setters.setBusy(null);
    if (signal.aborted) await deleteExportJob(submission.renderId);
  }
}

export function subscribeAgentExportJobs(
  projectId: string,
  exportJobs: ExportJobStore,
  t: Translate,
  target?: MediaPoolTarget,
): () => void {
  return subscribeAgentExportSubmissions((submission) => {
    if (submission.projectId !== projectId) return;
    exportJobs.recover({
      id: `agent-export-${submission.renderId}`,
      label: submission.label,
      targetPath: null,
      createdAt: submission.createdAt,
      execute: (execution) => monitorAgentExport(submission, execution, t, target),
    });
  });
}
