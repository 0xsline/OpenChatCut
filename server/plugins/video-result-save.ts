import type { GenerationResult } from './generation-jobs.ts';
import { saveImageUrl, saveVideo } from './video-media.ts';

export async function saveVideoResults(
  jobId: string,
  name: string,
  videoUrl: string,
  lastFrameUrl?: string,
  fetchImpl?: Parameters<typeof saveVideo>[1],
): Promise<GenerationResult | GenerationResult[]> {
  const video = {
    assetId: jobId, kind: 'video' as const, name, ...await saveVideo(videoUrl, fetchImpl),
  };
  if (!lastFrameUrl) return video;
  const path = await saveImageUrl(lastFrameUrl, fetchImpl);
  return [video, {
    assetId: `${jobId}:last-frame`, kind: 'image', name: `${name} · Last frame`, path,
    durationSeconds: 5,
  }];
}
