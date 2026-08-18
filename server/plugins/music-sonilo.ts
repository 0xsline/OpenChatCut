import type { GenerationResult } from './generation-jobs.ts';
import { fetchGeneratedResult } from './result-download.ts';
import {
  SONILO_MUSIC_ENDPOINT,
  SONILO_MUSIC_MAX_VIDEO_SECONDS,
  assertSoniloVideoDuration,
  awaitSoniloTracks,
  saveSoniloAudioResponse,
  submitSoniloVideoTask,
  writeSoniloLicenseSidecar,
  type SoniloAudioTrack,
} from './sonilo-media.ts';
import type { MusicOptions, ValidMusicRequest } from './music-types.ts';

/** Video-to-music from the finished cut. One durable result; the optional
 * single style prompt is passed through, and the task id is registered before
 * polling so a restarted server resumes instead of resubmitting. */
export async function generateSoniloMusic(
  options: MusicOptions,
  input: ValidMusicRequest,
  onTaskAccepted: (taskId: string) => Promise<void>,
  existingTaskId?: string,
): Promise<SoniloAudioTrack[]> {
  const baseUrl = options.soniloBaseUrl.replace(/\/$/, '');
  let taskId = existingTaskId;
  if (!taskId) {
    if (!input.sourceAssetPath) throw new Error('Sonilo v2m requires a project video sourceAssetId');
    await assertSoniloVideoDuration(input.sourceAssetPath, SONILO_MUSIC_MAX_VIDEO_SECONDS, 'music');
    taskId = await submitSoniloVideoTask(
      baseUrl,
      options.soniloApiKey,
      SONILO_MUSIC_ENDPOINT,
      input.sourceAssetPath,
      input.prompt || undefined,
    );
    await onTaskAccepted(taskId);
  }
  return awaitSoniloTracks(baseUrl, options.soniloApiKey, taskId);
}

/** Download one result track from its presigned URL (no auth header) and
 * archive the per-track license id as a sidecar record. */
export async function soniloMusicResult(
  jobId: string,
  input: ValidMusicRequest,
  url: string,
  licenseId?: string,
): Promise<GenerationResult> {
  const saved = await saveSoniloAudioResponse(await fetchGeneratedResult(url, 'audio'), url);
  if (licenseId) await writeSoniloLicenseSidecar(saved.path, licenseId);
  return { assetId: jobId, kind: 'audio', name: input.name, licenseId, ...saved };
}
