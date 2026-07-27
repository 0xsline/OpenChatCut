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
import { exportMediaDir } from '../../export/mediaDir';
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
  const action = args.action as 'params' | 'status' | 'wait' | 'resume';
  if (!['params', 'status', 'wait', 'resume'].includes(action)) return { error: 'action must be params, status, wait, or resume' };
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
  const state = exportState(args, ctx);
  if (format === 'video' || format === 'xml') {
    const gate = fontFallbackGate(state, args.confirmFontFallback);
    if (gate) return gate;
  }
  if (format === 'subtitles') return exportSubtitles(args, state);
  if (format === 'audio' || format === 'video') return exportMedia(args, state, format);
  if (format === 'xml') return exportXml(args, state);
  return { error: 'format must be video, audio, subtitles, or xml' };
}

// Bounded-concurrency map for batch voice synth (KikiVoice rate-limit aware, order-preserving).
async function mapBoundedVoice<T, R>(items: readonly T[], bound: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(bound, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; out[i] = await fn(items[i]); }
  });
  await Promise.all(workers);
  return out;
}
const VOICE_BATCH_MAX = 50;
const VOICE_BATCH_CONCURRENCY = 4;

// submit_voice_batch: synth one clip per scene in parallel (one call, not N sequential submit_voice).
// Returns one audio asset per scene (assetId + durationInFrames) so the agent can place them
// back-to-back on A1. Per-item failure is isolated (a bad scene doesn't kill the batch).
const submitVoiceBatchHandler: Handler = async (args, ctx) => {
  const raw = Array.isArray(args.items) ? args.items : [];
  const items = raw
    .filter((it): it is Record<string, unknown> => !!it && typeof it === 'object' && !Array.isArray(it))
    .map((it) => ({
      text: typeof it.text === 'string' ? it.text : '',
      voiceId: typeof it.voiceId === 'string' && it.voiceId.trim() ? it.voiceId.trim() : undefined,
      name: typeof it.name === 'string' && it.name.trim() ? it.name.trim() : undefined,
    }))
    .filter((it) => it.text.trim())
    .slice(0, VOICE_BATCH_MAX);
  if (!items.length) return { error: 'items must be a non-empty array of {text} (max 50)' };
  const provider = args.provider === 'doubao' || args.provider === 'minimax' || args.provider === 'kikivoice' ? args.provider : 'kikivoice';
  const sharedVoice = typeof args.voiceId === 'string' && args.voiceId.trim() ? args.voiceId.trim() : undefined;
  const state = ctx.getState();
  const results = await mapBoundedVoice(items, VOICE_BATCH_CONCURRENCY, async (it) => {
    try {
      const input = buildSubmitVoiceArgs({ text: it.text, voiceId: it.voiceId ?? sharedVoice, provider, name: it.name });
      const asset = await submitVoice(input, state);
      addAsset(ctx, asset);
      return { ok: true, assetId: asset.id, durationInFrames: asset.durationInFrames, name: asset.name, text: it.text };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), text: it.text };
    }
  });
  const synthed = results.filter((r) => r.ok).length;
  return { ok: synthed > 0, synthed, failed: results.length - synthed, total: results.length, results };
};

const COMMANDS: Record<string, Handler> = {
  submit_image: safe(submitImageHandler),
  submit_voice: safe(submitVoiceHandler),
  submit_voice_batch: safe(submitVoiceBatchHandler),
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
