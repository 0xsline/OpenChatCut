import type { AgentContext } from '../context';
import type { MediaAsset, ProjectDoc, Timeline, TimelineState } from '../../editor/types';
import { submitImage } from '../../generate/image';
import { submitMusic, type MusicGenerationSubmission } from '../../generate/music';
import { submitSound } from '../../generate/sound';
import { submitSubtitleExport, type SubmitSubtitleExportArgs } from '../../generate/subtitles';
import { submitMediaExport, type SubmitMediaExportArgs } from '../../generate/media-export';
import { trackGenerationProgress } from '../../generate/progress';
import { submitVideo, type VideoGenerationSubmission } from '../../generate/video';
import { submitVoice } from '../../generate/voice';
import { timelineToFcpxml, type NleFormat } from '../../export/fcpxml';
import { exportMediaDir } from '../../export/mediaDir';
import { recordExport } from '../../persist/exportHistoryStore';
import {
  applyGenerationJobReports,
  cacheMediaFromUrl,
  registerTrackedJob,
  patchTrackedJob,
  resolveTrackedJobForProject,
  type GenerationRetryClass,
} from '../../persist/jobRegistryStore';
import { fontFallbackGate } from './font-tools';
import {
  buildSubmitImageArgs,
  buildSubmitMusicArgs,
  buildSubmitSoundArgs,
  buildSubmitVideoArgs,
  buildSubmitVoiceArgs,
  shouldAddImageToTimeline,
  type GenerateArgs,
} from './generate-tool-input';

type Handler = (args: GenerateArgs, ctx: AgentContext) => unknown | Promise<unknown>;

const safe = (handler: Handler): Handler => async (args, ctx) => {
  try {
    return await handler(args, ctx);
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      const structured = error as Error & { code: unknown; issues?: unknown };
      return { error: structured.message, code: structured.code, issues: structured.issues };
    }
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

function addAsset(ctx: AgentContext, asset: MediaAsset, timeline = false): void {
  ctx.commands.addAsset(asset);
  if (timeline) ctx.commands.addMediaItem(asset);
  void cacheMediaFromUrl(asset.src, asset.name);
}

const submitImageHandler: Handler = async (args, ctx) => {
  const input = buildSubmitImageArgs(args);
  const addToTimeline = shouldAddImageToTimeline(args);
  const assets = await submitImage(input, ctx.getState());
  assets.forEach((asset) => addAsset(ctx, asset, addToTimeline));
  return {
    ok: true, model: input.model ?? 'gpt-image-2',
    generated: assets.map((asset) => ({ assetId: asset.id, name: asset.name, src: asset.src, width: asset.width, height: asset.height })),
    addedTo: addToTimeline ? 'media-pool-and-proposed-timeline' : 'media-pool',
  };
};

const submitVoiceHandler: Handler = async (args, ctx) => {
  const input = buildSubmitVoiceArgs(args);
  const asset = await submitVoice(input, ctx.getState());
  addAsset(ctx, asset);
  return {
    ok: true, provider: input.provider, voiceId: input.voiceId, assetId: asset.id,
    name: asset.name, src: asset.src, subtitlePath: asset.props?.minimaxSubtitlePath, addedTo: 'media-pool',
  };
};

const submitSoundHandler: Handler = async (args, ctx) => {
  const asset = await submitSound(buildSubmitSoundArgs(args), ctx.getState());
  addAsset(ctx, asset);
  return { ok: true, assetId: asset.id, name: asset.name, src: asset.src, durationInFrames: asset.durationInFrames, addedTo: 'media-pool' };
};

async function registerSubmissionIntent(
  ctx: AgentContext,
  operationId: string,
  toolName: 'submit_music' | 'submit_video',
  label: string,
  submitArgs: Record<string, unknown>,
  provider?: string,
  model?: string,
): Promise<void> {
  const projectId = ctx.getProjectId?.();
  if (!projectId) return;
  const now = Date.now();
  await registerTrackedJob({
    operationId,
    jobId: operationId,
    projectId,
    kind: 'generation',
    label,
    status: 'submitting',
    toolName,
    submitArgs,
    provider,
    model,
    retryClass: 'none',
    timestamps: { submittedAt: now },
  });
}

function retryClassForSubmissionError(error: unknown): GenerationRetryClass {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:408|409|425|429|5\d\d)\b|network|fetch|timeout|temporar|unavailable/i.test(message)
    ? 'provider-retryable'
    : 'provider-terminal';
}

async function recordSubmissionFailure(
  ctx: AgentContext,
  operationId: string,
  error: unknown,
): Promise<GenerationRetryClass> {
  const retryClass = retryClassForSubmissionError(error);
  const projectId = ctx.getProjectId?.();
  if (!projectId) return retryClass;
  await patchTrackedJob(projectId, operationId, {
    status: 'failed',
    error: error instanceof Error ? error.message : String(error),
    retryClass,
    releaseIdempotencyKey: retryClass === 'provider-terminal',
    timestamps: { failedAt: Date.now() },
  });
  return retryClass;
}

async function trackSubmission(
  ctx: AgentContext,
  submission: {
    operationId: string;
    jobId: string;
    status: 'queued';
    provider?: string;
    providerTaskId?: string;
    acceptedAt?: number;
    sourceRevisions?: string[];
  },
  label: string,
  toolName: 'submit_music' | 'submit_video',
  submitArgs: Record<string, unknown>,
  model?: string,
): Promise<void> {
  const projectId = ctx.getProjectId?.();
  if (!projectId) return;
  const now = Date.now();
  await registerTrackedJob({
    operationId: submission.operationId,
    jobId: submission.jobId,
    projectId,
    kind: 'generation',
    label,
    status: submission.status,
    toolName,
    submitArgs,
    provider: submission.provider,
    model,
    providerTaskId: submission.providerTaskId,
    sourceRevisions: submission.sourceRevisions,
    retryClass: 'none',
    timestamps: { submittedAt: now, acceptedAt: submission.acceptedAt ?? now },
  });
}

function submissionOperationId(args: GenerateArgs): string {
  if (args.__rerunGeneration === true) return crypto.randomUUID();
  if (typeof args.__operationId === 'string' && args.__operationId.trim()) return args.__operationId;
  throw new Error('generation submission requires a reserved operation id');
}

const submitMusicHandler: Handler = async (args, ctx) => {
  const input = buildSubmitMusicArgs(args);
  const operationId = submissionOperationId(args);
  const submitArgs: Record<string, unknown> = { ...input };
  const label = input.name || input.prompt?.slice(0, 80) || input.mode || 'music';
  await registerSubmissionIntent(ctx, operationId, 'submit_music', label, submitArgs, input.provider, input.provider);
  let submission: MusicGenerationSubmission;
  try {
    submission = await submitMusic({ ...input, operationId }, ctx.getState());
  } catch (error) {
    const retryClass = await recordSubmissionFailure(ctx, operationId, error);
    if (retryClass === 'provider-retryable') {
      return {
        status: 'pending',
        resumable: true,
        operationId,
        jobId: operationId,
        retryClass,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    throw error;
  }
  await trackSubmission(ctx, submission, label, 'submit_music', submitArgs, input.provider);
  return { ok: true, ...submission, next: `Call track_progress with target=generation and jobIds=${submission.jobId}.` };
};

const submitVideoHandler: Handler = async (args, ctx) => {
  const input = buildSubmitVideoArgs(args);
  const operationId = submissionOperationId(args);
  const submitArgs: Record<string, unknown> = { ...input };
  const label = input.name || input.prompt?.slice(0, 80) || input.model;
  await registerSubmissionIntent(ctx, operationId, 'submit_video', label, submitArgs, input.model, input.model);
  let submission: VideoGenerationSubmission;
  try {
    submission = await submitVideo({ ...input, operationId }, ctx.getState());
  } catch (error) {
    const retryClass = await recordSubmissionFailure(ctx, operationId, error);
    if (retryClass === 'provider-retryable') {
      return {
        status: 'pending',
        resumable: true,
        operationId,
        jobId: operationId,
        retryClass,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    throw error;
  }
  await trackSubmission(ctx, submission, label, 'submit_video', submitArgs, input.model);
  return { ok: true, model: input.model, ...submission, next: `Call track_progress with target=generation and jobIds=${submission.jobId}.` };
};

async function trackProgressHandler(args: GenerateArgs, ctx: AgentContext): Promise<unknown> {
  if (args.target !== 'generation') return { error: 'this local track_progress implementation currently supports target=generation only' };
  const action = args.action as 'params' | 'status' | 'wait' | 'resume';
  if (!['params', 'status', 'wait', 'resume'].includes(action)) return { error: 'action must be params, status, wait, or resume' };
  const jobIds = String(args.jobIds ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  const result = await trackGenerationProgress({
    action,
    jobIds,
    timeoutSeconds: typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : undefined,
  }, ctx.getState());
  const projectId = ctx.getProjectId?.();
  if (projectId) await applyGenerationJobReports(projectId, result.reports);
  result.completedAssets.forEach((asset) => addAsset(ctx, asset));
  return {
    ok: true, target: 'generation', action, reports: result.reports,
    addedAssets: result.completedAssets.map((asset) => ({ assetId: asset.id, name: asset.name, src: asset.src, kind: asset.kind })),
    addedTo: result.completedAssets.length ? 'media-pool' : undefined,
  };
}

const frameRangeOf = (start?: number, end?: number): { start: number; end: number } | undefined =>
  typeof start === 'number' && typeof end === 'number' ? { start, end } : undefined;

interface ExportTarget {
  project: ProjectDoc;
  state: Timeline;
  timelineId: string;
}

function exportTarget(args: GenerateArgs, ctx: AgentContext): ExportTarget {
  const project = ctx.getDoc();
  const query = typeof args.timelineId === 'string' && args.timelineId.trim()
    ? args.timelineId.trim()
    : project.activeTimelineId;
  const state = project.timelines.find((timeline) => timeline.id === query || timeline.id.startsWith(query));
  if (!state) throw new Error(`timeline not found: ${args.timelineId ?? query}`);
  return { project, state, timelineId: state.id };
}

async function exportSubtitles(args: GenerateArgs, state: TimelineState): Promise<unknown> {
  const input: SubmitSubtitleExportArgs = {
    subtitleFormat: args.subtitleFormat as SubmitSubtitleExportArgs['subtitleFormat'], name: typeof args.name === 'string' ? args.name : undefined,
    captionTrackId: typeof args.captionTrackId === 'string' ? args.captionTrackId : undefined,
    startFrame: typeof args.startFrame === 'number' ? args.startFrame : undefined,
    endFrameExclusive: typeof args.endFrameExclusive === 'number' ? args.endFrameExclusive : undefined,
    startSeconds: typeof args.startSeconds === 'number' ? args.startSeconds : undefined,
    endSeconds: typeof args.endSeconds === 'number' ? args.endSeconds : undefined,
  };
  const result = await submitSubtitleExport(input, state);
  void recordExport({ name: result.name ?? `subtitles.${input.subtitleFormat ?? 'srt'}`, format: 'subtitles', frameRange: frameRangeOf(input.startFrame, input.endFrameExclusive), createdAt: Date.now() });
  return { ok: true, ...result };
}

async function exportMedia(args: GenerateArgs, target: ExportTarget, format: 'audio' | 'video'): Promise<unknown> {
  const fps = typeof args.fps === 'number' ? args.fps : undefined;
  if (fps != null && ![24, 25, 30, 50, 60].includes(fps)) throw new Error('fps must be one of 24, 25, 30, 50, 60');
  const resolution = args.resolution === '480p' || args.resolution === '720p' || args.resolution === '1080p' ? args.resolution : undefined;
  const input: SubmitMediaExportArgs = {
    format, codec: args.codec as SubmitMediaExportArgs['codec'], name: typeof args.name === 'string' ? args.name : undefined,
    startFrame: typeof args.startFrame === 'number' ? args.startFrame : undefined,
    endFrameExclusive: typeof args.endFrameExclusive === 'number' ? args.endFrameExclusive : undefined,
    startSeconds: typeof args.startSeconds === 'number' ? args.startSeconds : undefined,
    endSeconds: typeof args.endSeconds === 'number' ? args.endSeconds : undefined,
    fps,
    resolution,
    videoBitrate: typeof args.videoBitrate === 'number' ? args.videoBitrate : undefined,
  };
  const result = await submitMediaExport(input, target.project, target.timelineId);
  void recordExport({ name: result.name, format: result.format, codec: result.codec, sizeBytes: result.sizeBytes, frameRange: frameRangeOf(result.startFrame, result.endFrameExclusive), createdAt: Date.now() });
  return { ok: true, ...result };
}

async function exportXml(args: GenerateArgs, state: TimelineState): Promise<unknown> {
  const nleFormat: NleFormat = args.nleFormat === 'fcp_xml_resolve' ? 'fcp_xml_resolve' : 'fcp_xml';
  const keys = Array.isArray(args.motionGraphicRenderKeys)
    ? args.motionGraphicRenderKeys.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
    : [];
  const xml = timelineToFcpxml(state, { title: typeof args.name === 'string' ? args.name : undefined, nleFormat, motionGraphicRenderKeys: keys, mediaDir: await exportMediaDir() });
  const base = (typeof args.name === 'string' && args.name ? args.name : 'timeline').replace(/\.(?:fcpxml|xml)$/i, '');
  const filename = `${base}.fcpxml`;
  const blob = new Blob([xml], { type: 'application/xml' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  void recordExport({ name: filename, format: 'xml', sizeBytes: blob.size, createdAt: Date.now() });
  return { ok: true, format: 'xml', nleFormat, name: filename, sizeBytes: blob.size, motionGraphicRenderKeys: keys };
}

async function submitExportHandler(args: GenerateArgs, ctx: AgentContext): Promise<unknown> {
  const format = args.format ?? 'video';
  const target = exportTarget(args, ctx);
  if (format === 'video' || format === 'xml') {
    const gate = fontFallbackGate(target.state, args.confirmFontFallback);
    if (gate) return gate;
  }
  if (format === 'subtitles') return exportSubtitles(args, target.state);
  if (format === 'audio' || format === 'video') return exportMedia(args, target, format);
  if (format === 'xml') return exportXml(args, target.state);
  return { error: 'format must be video, audio, subtitles, or xml' };
}

async function rerunGenerationHandler(args: GenerateArgs, ctx: AgentContext): Promise<unknown> {
  const projectId = ctx.getProjectId?.();
  if (!projectId) return { error: 'rerun_generation requires a persisted project id' };
  const resolution = await resolveTrackedJobForProject(projectId, String(args.jobId ?? ''));
  if (!resolution.ok) return {
    error: resolution.message,
    code: resolution.code,
    candidates: resolution.candidates,
  };
  const original = resolution.job;
  if (original.submitArgsVersion !== 1 || !original.submitArgs || !original.toolName) {
    return {
      error: `generation operation ${original.operationId} is a legacy summary-only snapshot and cannot be rerun safely`,
      code: 'legacy_summary',
    };
  }
  const rerunArgs: GenerateArgs = {
    ...original.submitArgs,
    __rerunGeneration: true,
    __rerunOf: original.operationId,
  };
  const result = original.toolName === 'submit_video'
    ? await submitVideoHandler(rerunArgs, ctx)
    : original.toolName === 'submit_music'
      ? await submitMusicHandler(rerunArgs, ctx)
      : { error: `generation operation ${original.operationId} uses unsupported rerun tool ${original.toolName}` };
  return result && typeof result === 'object' && !Array.isArray(result)
    ? { ...(result as Record<string, unknown>), rerunOf: original.operationId }
    : result;
}

const COMMANDS: Record<string, Handler> = {
  submit_image: safe(submitImageHandler),
  submit_voice: safe(submitVoiceHandler),
  submit_sound: safe(submitSoundHandler),
  submit_music: safe(submitMusicHandler),
  submit_video: safe(submitVideoHandler),
  track_progress: safe(trackProgressHandler),
  rerun_generation: safe(rerunGenerationHandler),
  submit_export: safe(submitExportHandler),
};

export function executeGenerateCommand(name: string, args: GenerateArgs, ctx: AgentContext): unknown | Promise<unknown> {
  const handler = COMMANDS[name];
  return handler ? handler(args, ctx) : { error: `generate tool not implemented: ${name}` };
}
