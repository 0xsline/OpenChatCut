import type { AgentContext } from '../context';
import type { MediaAsset, TimelineState } from '../../editor/types';
import { submitImage } from '../../generate/image';
import { submitMusic } from '../../generate/music';
import { submitSound } from '../../generate/sound';
import { submitSubtitleExport, type SubmitSubtitleExportArgs } from '../../generate/subtitles';
import { submitMediaExport, type SubmitMediaExportArgs } from '../../generate/media-export';
import { trackGenerationProgress } from '../../generate/progress';
import { submitVideo } from '../../generate/video';
import { submitVoice } from '../../generate/voice';
import { timelineToFcpxml, type NleFormat } from '../../export/fcpxml';
import { recordExport } from '../../persist/exportHistoryStore';
import { cacheMediaFromUrl, patchTrackedJob, registerTrackedJob } from '../../persist/jobRegistryStore';
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

function trackSubmission(ctx: AgentContext, jobId: string, status: 'queued', label: string, params: Record<string, unknown>): void {
  const projectId = ctx.getProjectId?.();
  if (!projectId) return;
  void registerTrackedJob({ jobId, projectId, kind: 'generation', label, status, params });
}

const submitMusicHandler: Handler = async (args, ctx) => {
  const input = buildSubmitMusicArgs(args);
  const submission = await submitMusic(input, ctx.getState());
  trackSubmission(ctx, submission.jobId, submission.status, input.name || input.prompt?.slice(0, 80) || input.mode || 'music', {
    tool: 'submit_music', prompt: input.prompt, provider: input.provider, mode: input.mode,
  });
  return { ok: true, ...submission, next: `Call track_progress with target=generation and jobIds=${submission.jobId}.` };
};

const submitVideoHandler: Handler = async (args, ctx) => {
  const input = buildSubmitVideoArgs(args);
  const submission = await submitVideo(input, ctx.getState());
  trackSubmission(ctx, submission.jobId, submission.status, input.name || input.prompt?.slice(0, 80) || input.model, {
    tool: 'submit_video', model: input.model, prompt: input.prompt,
  });
  return { ok: true, model: input.model, ...submission, next: `Call track_progress with target=generation and jobIds=${submission.jobId}.` };
};

async function trackProgressHandler(args: GenerateArgs, ctx: AgentContext): Promise<unknown> {
  if (args.target !== 'generation') return { error: 'this local track_progress implementation currently supports target=generation only' };
  const action = args.action as 'params' | 'status' | 'wait';
  if (!['params', 'status', 'wait'].includes(action)) return { error: 'action must be params, status, or wait' };
  const jobIds = String(args.jobIds ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  const projectId = ctx.getProjectId?.();
  if (projectId) for (const jobId of jobIds) void registerTrackedJob({ jobId, projectId, kind: 'generation', status: 'running' });
  const result = await trackGenerationProgress({ action, jobIds, timeoutSeconds: typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : undefined }, ctx.getState());
  if (projectId) {
    for (const report of result.reports) {
      void patchTrackedJob(projectId, report.jobId, {
        status: report.status, error: report.error, resultPath: report.result?.path, resultAssetId: report.result?.assetId,
      });
    }
  }
  result.completedAssets.forEach((asset) => addAsset(ctx, asset));
  return {
    ok: true, target: 'generation', action, reports: result.reports,
    addedAssets: result.completedAssets.map((asset) => ({ assetId: asset.id, name: asset.name, src: asset.src, kind: asset.kind })),
    addedTo: result.completedAssets.length ? 'media-pool' : undefined,
  };
}

const frameRangeOf = (start?: number, end?: number): { start: number; end: number } | undefined =>
  typeof start === 'number' && typeof end === 'number' ? { start, end } : undefined;

function exportState(args: GenerateArgs, ctx: AgentContext): TimelineState {
  if (typeof args.timelineId !== 'string' || !args.timelineId.trim()) return ctx.getState();
  const query = args.timelineId.trim();
  const timeline = ctx.getDoc().timelines.find((item) => item.id === query || item.id.startsWith(query));
  if (!timeline) throw new Error(`timeline not found: ${args.timelineId}`);
  return timeline;
}

async function exportSubtitles(args: GenerateArgs, state: TimelineState): Promise<unknown> {
  const input: SubmitSubtitleExportArgs = {
    subtitleFormat: args.subtitleFormat as SubmitSubtitleExportArgs['subtitleFormat'], name: typeof args.name === 'string' ? args.name : undefined,
    startFrame: typeof args.startFrame === 'number' ? args.startFrame : undefined,
    endFrameExclusive: typeof args.endFrameExclusive === 'number' ? args.endFrameExclusive : undefined,
    startSeconds: typeof args.startSeconds === 'number' ? args.startSeconds : undefined,
    endSeconds: typeof args.endSeconds === 'number' ? args.endSeconds : undefined,
  };
  const result = await submitSubtitleExport(input, state);
  void recordExport({ name: result.name ?? `subtitles.${input.subtitleFormat ?? 'srt'}`, format: 'subtitles', frameRange: frameRangeOf(input.startFrame, input.endFrameExclusive), createdAt: Date.now() });
  return { ok: true, ...result };
}

async function exportMedia(args: GenerateArgs, state: TimelineState, format: 'audio' | 'video'): Promise<unknown> {
  const fps = typeof args.fps === 'number' ? args.fps : undefined;
  if (fps != null && ![24, 25, 30, 50, 60].includes(fps)) throw new Error('fps must be one of 24, 25, 30, 50, 60');
  const resolution = args.resolution === '480p' || args.resolution === '720p' || args.resolution === '1080p' ? args.resolution : undefined;
  const input: SubmitMediaExportArgs = {
    format, codec: args.codec as SubmitMediaExportArgs['codec'], name: typeof args.name === 'string' ? args.name : undefined,
    startFrame: typeof args.startFrame === 'number' ? args.startFrame : undefined,
    endFrameExclusive: typeof args.endFrameExclusive === 'number' ? args.endFrameExclusive : undefined,
    startSeconds: typeof args.startSeconds === 'number' ? args.startSeconds : undefined,
    endSeconds: typeof args.endSeconds === 'number' ? args.endSeconds : undefined, fps, resolution,
  };
  const result = await submitMediaExport(input, state);
  void recordExport({ name: result.name, format: result.format, codec: result.codec, sizeBytes: result.sizeBytes, frameRange: frameRangeOf(result.startFrame, result.endFrameExclusive), createdAt: Date.now() });
  return { ok: true, ...result };
}

function exportXml(args: GenerateArgs, state: TimelineState): unknown {
  const nleFormat: NleFormat = args.nleFormat === 'fcp_xml_resolve' ? 'fcp_xml_resolve' : 'fcp_xml';
  const keys = Array.isArray(args.motionGraphicRenderKeys)
    ? args.motionGraphicRenderKeys.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
    : [];
  const xml = timelineToFcpxml(state, { title: typeof args.name === 'string' ? args.name : undefined, nleFormat, motionGraphicRenderKeys: keys });
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
  const state = exportState(args, ctx);
  if (format === 'video' || format === 'xml') {
    const gate = fontFallbackGate(state, args.confirmFontFallback, { captions: state.captions ?? null });
    if (gate) return gate;
  }
  if (format === 'subtitles') return exportSubtitles(args, state);
  if (format === 'audio' || format === 'video') return exportMedia(args, state, format);
  if (format === 'xml') return exportXml(args, state);
  return { error: 'format must be video, audio, subtitles, or xml' };
}

const COMMANDS: Record<string, Handler> = {
  submit_image: safe(submitImageHandler),
  submit_voice: safe(submitVoiceHandler),
  submit_sound: safe(submitSoundHandler),
  submit_music: safe(submitMusicHandler),
  submit_video: safe(submitVideoHandler),
  track_progress: safe(trackProgressHandler),
  submit_export: safe(submitExportHandler),
};

export function executeGenerateCommand(name: string, args: GenerateArgs, ctx: AgentContext): unknown | Promise<unknown> {
  const handler = COMMANDS[name];
  return handler ? handler(args, ctx) : { error: `generate tool not implemented: ${name}` };
}
