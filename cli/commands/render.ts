// `occ render` — render the saved project to a file with the server's own export
// pipeline: the same plan builder, media materialization and Remotion render the
// /export job route drives. Only the transport differs — no HTTP, no browser
// dialog, no render queue. Nothing here modifies the project.
import { randomUUID } from 'node:crypto';
import { rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { flagBoolean, flagText, rejectUnknownFlags, type CommandLine } from '../args.ts';
import { CliError, UsageError } from '../errors.ts';
import { printJson, writeStderr, writeStdout } from '../output.ts';
import { readProjectDoc, resolveProject } from '../store.ts';
import { resolveH264TargetBitrate } from '../../server/media-acceleration.ts';
import { acceptExportSubmission } from '../../server/plugins/export-submission.ts';
import { h264RenderOptions, renderTimeline } from '../../server/plugins/export-rendering.ts';
import { exportOutputSize, retimeFps, withExportPermit } from '../../server/plugins/export-runtime.ts';
import { GLOBAL_FLAGS, parseFrames, projectReference } from './common.ts';

const FLAGS = [
  ...GLOBAL_FLAGS,
  'out', 'timeline', 'format', 'codec', 'resolution', 'fps', 'bitrate', 'from', 'to', 'quiet', 'dry-run',
] as const;

const FORMATS = ['video', 'audio'] as const;
const CODECS = ['h264', 'vp8', 'prores', 'mp3', 'wav'] as const;
const RESOLUTIONS = ['480p', '720p', '1080p', '4k'] as const;

function oneOf<T extends string>(value: string, allowed: readonly T[], flag: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new UsageError(`--${flag} must be one of ${allowed.join(', ')}`);
}

function positiveNumber(input: string, flag: string): number {
  const value = Number(input);
  if (!Number.isFinite(value) || value <= 0) {
    throw new UsageError(`--${flag} expects a positive number, got "${input}"`);
  }
  return value;
}

export async function runRenderCommand(commandLine: CommandLine, json: boolean): Promise<void> {
  rejectUnknownFlags(commandLine, FLAGS);
  const outPath = flagText(commandLine, 'out');
  if (outPath === undefined || !outPath.trim()) {
    throw new UsageError('render needs --out <file> (for example: occ render --out cut.mp4)');
  }
  const quiet = flagBoolean(commandLine, 'quiet');
  const project = await resolveProject(projectReference(commandLine));
  const doc = await readProjectDoc(project.id);
  const timelineId = flagText(commandLine, 'timeline') ?? doc.activeTimelineId;
  const timeline = doc.timelines.find((candidate) => candidate.id === timelineId);
  if (!timeline) {
    throw new CliError(`Project ${project.name} has no timeline ${timelineId}.\n${
      doc.timelines.map((candidate) => `  ${candidate.id}  ${candidate.name}`).join('\n')}`);
  }
  const format = oneOf(flagText(commandLine, 'format') ?? 'video', FORMATS, 'format');
  const codecFlag = flagText(commandLine, 'codec');
  const resolutionFlag = flagText(commandLine, 'resolution');
  const fpsFlag = flagText(commandLine, 'fps');
  const bitrateFlag = flagText(commandLine, 'bitrate');
  const fromFlag = flagText(commandLine, 'from');
  const toFlag = flagText(commandLine, 'to');

  const submission = await acceptExportSubmission({
    state: { ...timeline, assets: doc.assets },
    project: doc,
    timelineId: timeline.id,
    format,
    ...(codecFlag === undefined ? {} : { codec: oneOf(codecFlag, CODECS, 'codec') }),
    ...(resolutionFlag === undefined ? {} : { resolution: oneOf(resolutionFlag, RESOLUTIONS, 'resolution') }),
    ...(fpsFlag === undefined ? {} : { fps: positiveNumber(fpsFlag, 'fps') }),
    ...(bitrateFlag === undefined ? {} : { videoBitrate: positiveNumber(bitrateFlag, 'bitrate') }),
    ...(fromFlag === undefined ? {} : { startFrame: parseFrames(fromFlag, timeline.fps, 'from') }),
    ...(toFlag === undefined ? {} : { endFrameExclusive: parseFrames(toFlag, timeline.fps, 'to') }),
  });
  const plan = submission.plan;
  if (flagBoolean(commandLine, 'dry-run')) {
    await submission.cleanup();
    const summary = {
      projectId: project.id,
      timelineId: timeline.id,
      output: outPath,
      codec: plan.media.codec,
      extension: plan.media.ext,
      scale: plan.scale,
      frameRange: plan.frameRange ?? null,
      totalFrames: plan.totalFrames,
      durationSeconds: plan.durationSeconds,
      filename: plan.filename,
    };
    if (json) printJson(summary);
    else writeStdout(`plan: ${plan.media.codec} ${plan.totalFrames} frames → ${outPath}`);
    return;
  }
  // The partial keeps the final extension: Remotion validates the output filename
  // against the codec (a ".partial" suffix makes it refuse to render).
  const extension = plan.media.ext;
  const partial = join(dirname(outPath), `${basename(outPath, `.${extension}`)}.partial-${randomUUID()}.${extension}`);
  try {
    await withExportPermit(async () => {
      await renderTimeline({
        state: plan.state,
        project: plan.project,
        timelineId: plan.timelineId,
        outputLocation: partial,
        codec: plan.media.codec,
        frameRange: plan.frameRange,
        scale: plan.scale,
        videoBitrate: plan.videoBitrate,
        ...await h264RenderOptions(plan.media.codec),
        ...(quiet ? {} : {
          onProgress: (progress: number) => {
            writeStderr(`rendering ${Math.round(progress * 100)}%`);
          },
        }),
      });
      if (plan.retimeFps !== undefined) {
        const outputSize = exportOutputSize(plan.state, plan.scale);
        const retimed = `${partial}.retimed.${extension}`;
        await retimeFps(
          partial,
          retimed,
          plan.retimeFps,
          plan.media.codec as 'h264' | 'vp8',
          plan.videoBitrate ?? resolveH264TargetBitrate({ ...outputSize, fps: plan.retimeFps }),
          undefined,
        );
        await unlink(partial).catch(() => {});
        await rename(retimed, partial);
      }
    });
    await rename(partial, outPath);
  } catch (error) {
    await unlink(partial).catch(() => {});
    throw error;
  } finally {
    await submission.cleanup();
  }

  const size = (await stat(outPath)).size;
  if (json) {
    printJson({
      projectId: project.id,
      timelineId: timeline.id,
      output: outPath,
      bytes: size,
      codec: plan.media.codec,
      frames: plan.totalFrames,
      durationSeconds: plan.durationSeconds,
    });
    return;
  }
  writeStdout(`${outPath}  ${(size / (1024 * 1024)).toFixed(1)}MB  ${plan.media.codec}  ${
    plan.durationSeconds.toFixed(2)}s  ${plan.totalFrames} frames`);
}
