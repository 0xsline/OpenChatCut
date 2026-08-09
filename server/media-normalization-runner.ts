import { rename, stat, unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import {
  createNormalizeTempPath,
  encodeNormalized,
  normalizeAdmission,
  normalizeReason,
  playableDurationSeconds,
  probeVideo,
  recommendedBitrate,
  resolveNormalizeOutputPath,
  resolveNormalizeTargetKey,
  resolveStreamPlan,
  resolveTargetFps,
  targetDimension,
  throwIfNormalizationAborted,
  type NormalizeAdmission,
  type NormalizeEncodeContext,
  type ProbeMeta,
  type ReleaseNormalizePermit,
} from './media-normalization.ts';
import { putUploadFile, r2Config } from './r2.ts';
import { uploadDir } from './media-dir.ts';

export interface NormalizeMediaFileResult {
  readonly path: string;
  readonly outputPath: string;
  readonly normalized: boolean;
  readonly reason: string;
  readonly bytes: number;
  readonly bytesBefore?: number;
  readonly width: number;
  readonly height: number;
  readonly durationSeconds?: number;
  readonly videoFrameCount?: number;
  readonly sourceFps?: number;
  readonly variableFrameRate: boolean;
}

export interface NormalizeMediaFileOptions {
  readonly inputPath: string;
  readonly publicSrc: string;
  readonly force?: boolean;
  readonly optimize?: boolean;
  readonly forceCfr?: boolean;
  readonly targetFps?: number;
  readonly signal?: AbortSignal;
  readonly admission?: NormalizeAdmission;
  readonly encoderHook?: (
    context: NormalizeEncodeContext,
    encode: () => Promise<void>,
  ) => Promise<void>;
  readonly publishR2?: boolean;
  readonly uploadsDirectory?: string;
  readonly logInfo?: (message: string) => void;
  readonly logError?: (message: string) => void;
}

interface NormalizePlan {
  readonly meta: ProbeMeta;
  readonly targetW: number;
  readonly targetH: number;
  readonly targetBitrate: number;
  readonly targetFps: number;
  readonly convertToCfr: boolean;
  readonly reason: string | null;
  readonly optimizeOutput: boolean;
}

export class NormalizeMediaProbeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NormalizeMediaProbeError';
  }
}

async function createNormalizePlan(options: NormalizeMediaFileOptions): Promise<NormalizePlan> {
  let meta: ProbeMeta;
  try {
    meta = await probeVideo(options.inputPath, options.signal);
  } catch (error) {
    throw new NormalizeMediaProbeError(
      `video compatibility check failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const optimizeOutput = options.force === true || options.optimize === true;
  const { w: targetW, h: targetH } = targetDimension(meta.width, meta.height, optimizeOutput);
  const recommended = recommendedBitrate(targetW, targetH);
  const targetBitrate = optimizeOutput ? recommended : Math.max(recommended, meta.sourceBitrate);
  const forceCfr = options.forceCfr === true;
  const targetFps = resolveTargetFps(
    options.targetFps, meta.avgFrameRate, meta.nominalFrameRate, forceCfr || optimizeOutput,
  );
  return {
    meta,
    targetW,
    targetH,
    targetBitrate,
    targetFps,
    convertToCfr: forceCfr || meta.variableFrameRate,
    reason: options.force ? 'force' : normalizeReason(meta, targetBitrate, forceCfr, options.optimize === true),
    optimizeOutput,
  };
}

function acceptedResult(options: NormalizeMediaFileOptions, meta: ProbeMeta): NormalizeMediaFileResult {
  return {
    path: options.publicSrc,
    outputPath: options.inputPath,
    normalized: false,
    reason: 'source accepted',
    bytes: meta.size,
    width: meta.width,
    height: meta.height,
    durationSeconds: playableDurationSeconds(meta) || undefined,
    videoFrameCount: meta.frameCount,
    sourceFps: meta.avgFrameRate ?? meta.nominalFrameRate,
    variableFrameRate: meta.variableFrameRate,
  };
}

async function publishSamePath(
  inputPath: string,
  tempPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const backup = `${inputPath}.bak-norm`;
  await unlink(backup).catch(() => {});
  throwIfNormalizationAborted(signal);
  await rename(inputPath, backup);
  try {
    throwIfNormalizationAborted(signal);
    await rename(tempPath, inputPath);
    throwIfNormalizationAborted(signal);
    await unlink(backup).catch(() => {});
    return inputPath;
  } catch (error) {
    await unlink(inputPath).catch(() => {});
    await rename(backup, inputPath).catch(() => {});
    throw error;
  }
}

async function publishNewPath(
  inputPath: string,
  outputPath: string,
  tempPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const backup = `${inputPath}.bak-norm`;
  await unlink(backup).catch(() => {});
  await unlink(outputPath).catch(() => {});
  throwIfNormalizationAborted(signal);
  await rename(inputPath, backup);
  try {
    throwIfNormalizationAborted(signal);
    await rename(tempPath, outputPath);
    throwIfNormalizationAborted(signal);
    await unlink(backup).catch(() => {});
    return outputPath;
  } catch (error) {
    await unlink(outputPath).catch(() => {});
    await rename(backup, inputPath).catch(() => {});
    throw error;
  }
}

async function publishNormalized(
  inputPath: string,
  outputPath: string,
  tempPath: string,
  signal?: AbortSignal,
): Promise<string> {
  return outputPath === inputPath || basename(outputPath) === basename(inputPath)
    ? publishSamePath(inputPath, tempPath, signal)
    : publishNewPath(inputPath, outputPath, tempPath, signal);
}

async function refreshNormalizedR2(
  path: string,
  options: NormalizeMediaFileOptions,
): Promise<void> {
  if (!options.publishR2 || !r2Config()) return;
  try {
    await putUploadFile(basename(path), path, 'video/mp4');
  } catch (error) {
    options.logError?.(`[normalize-media→R2] ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  throwIfNormalizationAborted(options.signal);
}

async function cleanStaleAudioCaches(
  outputPath: string,
  options: NormalizeMediaFileOptions,
): Promise<void> {
  const stem = basename(outputPath, extname(outputPath));
  const directory = options.uploadsDirectory ?? uploadDir();
  for (const suffix of ['asr.ogg', 'asr.mp3']) {
    await unlink(join(directory, `${stem}.${suffix}`)).catch(() => {});
  }
  throwIfNormalizationAborted(options.signal);
}

async function normalizedResult(
  options: NormalizeMediaFileOptions,
  plan: NormalizePlan,
  finalPath: string,
): Promise<NormalizeMediaFileResult> {
  const bytes = (await stat(finalPath)).size;
  throwIfNormalizationAborted(options.signal);
  const finalMeta = await probeVideo(finalPath, options.signal);
  return {
    path: `/media/uploads/${basename(finalPath)}`,
    outputPath: finalPath,
    normalized: true,
    reason: plan.reason!,
    bytes,
    bytesBefore: plan.meta.size,
    width: finalMeta.width,
    height: finalMeta.height,
    durationSeconds: playableDurationSeconds(finalMeta) || playableDurationSeconds(plan.meta) || undefined,
    videoFrameCount: finalMeta.frameCount,
    sourceFps: finalMeta.avgFrameRate ?? plan.targetFps,
    variableFrameRate: finalMeta.variableFrameRate,
  };
}

async function encodePlannedMedia(
  options: NormalizeMediaFileOptions,
  plan: NormalizePlan,
  outputPath: string,
  tempPath: string,
): Promise<void> {
  const streamPlan = resolveStreamPlan(plan.meta, plan.optimizeOutput, plan.convertToCfr);
  const encode = () => encodeNormalized(
    options.inputPath,
    tempPath,
    plan.meta,
    plan.targetW,
    plan.targetH,
    plan.targetBitrate,
    plan.targetFps,
    plan.convertToCfr,
    streamPlan,
    options.signal,
  );
  if (options.encoderHook) {
    await options.encoderHook({ inputPath: options.inputPath, outputPath, tempPath }, encode);
  } else {
    await encode();
  }
  throwIfNormalizationAborted(options.signal);
}

export async function normalizeMediaFile(
  options: NormalizeMediaFileOptions,
): Promise<NormalizeMediaFileResult> {
  const outputPath = resolveNormalizeOutputPath(options.inputPath);
  const admission = options.admission ?? normalizeAdmission;
  let release: ReleaseNormalizePermit | undefined;
  let tempPath: string | undefined;
  try {
    release = await admission.acquire(await resolveNormalizeTargetKey(outputPath), options.signal);
    throwIfNormalizationAborted(options.signal);
    const plan = await createNormalizePlan(options);
    if (!plan.reason) return acceptedResult(options, plan.meta);
    tempPath = createNormalizeTempPath(outputPath);
    options.logInfo?.(`[normalize-media] ${basename(options.inputPath)}: ${plan.reason}`);
    await encodePlannedMedia(options, plan, outputPath, tempPath);
    const finalPath = await publishNormalized(options.inputPath, outputPath, tempPath, options.signal);
    tempPath = undefined;
    await refreshNormalizedR2(finalPath, options);
    await cleanStaleAudioCaches(outputPath, options);
    const result = await normalizedResult(options, plan, finalPath);
    options.logInfo?.(`[normalize-media] ${basename(options.inputPath)} → ${basename(finalPath)} (${plan.meta.size} → ${result.bytes} bytes)`);
    return result;
  } finally {
    if (tempPath) await unlink(tempPath).catch(() => {});
    release?.();
  }
}
