import { createGrayTemplate, findBestMatch, rgbaToGrayscale } from './templateMatch';
import {
  TrackingError,
  type GrayTemplate,
  type TrackingPoint,
  type TrackingRequest,
  type TrackingResult,
} from './types';

const MAX_ANALYSIS_WIDTH = 360;
const MAX_ANALYSIS_HEIGHT = 240;
const MAX_SAMPLES = 150;
const MAX_LOST_SAMPLES = 2;

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function waitForVideo(video: HTMLVideoElement, event: 'loadedmetadata' | 'seeked', signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new TrackingError(event === 'seeked' ? 'seek-failed' : 'load-failed')), 10_000);
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      video.removeEventListener(event, success);
      video.removeEventListener('error', failure);
      signal?.removeEventListener('abort', cancelled);
      if (error) reject(error);
      else resolve();
    };
    const success = () => finish();
    const failure = () => finish(new TrackingError(event === 'seeked' ? 'seek-failed' : 'load-failed'));
    const cancelled = () => finish(abortError());
    video.addEventListener(event, success, { once: true });
    video.addEventListener('error', failure, { once: true });
    signal?.addEventListener('abort', cancelled, { once: true });
  });
}

async function loadVideo(src: string, signal?: AbortSignal): Promise<HTMLVideoElement> {
  assertActive(signal);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  video.src = src;
  await waitForVideo(video, 'loadedmetadata', signal);
  return video;
}

async function seekVideo(video: HTMLVideoElement, time: number, signal?: AbortSignal): Promise<void> {
  assertActive(signal);
  const safeTime = Math.max(0, Math.min(Math.max(0, video.duration - 0.001), time));
  if (Math.abs(video.currentTime - safeTime) < 0.0005 && video.readyState >= 2) return;
  const pending = waitForVideo(video, 'seeked', signal);
  video.currentTime = safeTime;
  await pending;
}

function analysisSize(video: HTMLVideoElement): { width: number; height: number } {
  if (video.videoWidth < 8 || video.videoHeight < 8) throw new TrackingError('load-failed');
  const scale = Math.min(1, MAX_ANALYSIS_WIDTH / video.videoWidth, MAX_ANALYSIS_HEIGHT / video.videoHeight);
  return {
    width: Math.max(1, Math.round(video.videoWidth * scale)),
    height: Math.max(1, Math.round(video.videoHeight * scale)),
  };
}

function framePixels(video: HTMLVideoElement, canvas: HTMLCanvasElement): Uint8Array {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new TrackingError('load-failed');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return rgbaToGrayscale(context.getImageData(0, 0, canvas.width, canvas.height));
}

function regionPixels(region: TrackingRequest['region'], width: number, height: number) {
  const x = Math.max(0, Math.min(width - 8, Math.round(region.x * width)));
  const y = Math.max(0, Math.min(height - 8, Math.round(region.y * height)));
  const regionWidth = Math.max(8, Math.min(width - x, Math.round(region.width * width)));
  const regionHeight = Math.max(8, Math.min(height - y, Math.round(region.height * height)));
  if (regionWidth < 8 || regionHeight < 8) throw new TrackingError('invalid-region');
  return { x, y, width: regionWidth, height: regionHeight };
}

function sampleFrames(durationInFrames: number): number[] {
  const interval = Math.max(2, Math.ceil(durationInFrames / MAX_SAMPLES));
  const frames: number[] = [];
  for (let frame = 0; frame < durationInFrames; frame += interval) frames.push(frame);
  const last = Math.max(0, durationInFrames - 1);
  if (frames.at(-1) !== last) frames.push(last);
  return frames;
}

function averageConfidence(points: TrackingPoint[]): number {
  if (!points.length) return 0;
  return points.reduce((sum, point) => sum + point.confidence, 0) / points.length;
}

interface TrackSequenceOptions {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  template: GrayTemplate;
  frames: number[];
  request: TrackingRequest;
  initialX: number;
  initialY: number;
  regionWidth: number;
  regionHeight: number;
}

async function matchFrame(options: TrackSequenceOptions, localFrame: number, x: number, y: number, radius: number) {
  const { video, canvas, template, request } = options;
  const sourceTime = (request.srcInFrame + localFrame * request.playbackRate) / request.fps;
  if (sourceTime >= video.duration) return null;
  await seekVideo(video, sourceTime, request.signal);
  return findBestMatch(framePixels(video, canvas), canvas.width, canvas.height, template, x, y, radius);
}

async function trackFrameSequence(options: TrackSequenceOptions): Promise<{ points: TrackingPoint[]; processed: number; lost: boolean }> {
  const { canvas, frames, initialX, initialY, regionWidth, regionHeight, request } = options;
  const points: TrackingPoint[] = [{ frame: 0, x: (initialX + regionWidth / 2) / canvas.width, y: (initialY + regionHeight / 2) / canvas.height, confidence: 1 }];
  const radius = Math.max(14, Math.min(72, Math.round(Math.max(regionWidth, regionHeight) * 0.9)));
  const minConfidence = request.minConfidence ?? 0.68;
  let predictedX = initialX;
  let predictedY = initialY;
  let lostSamples = 0;
  let processed = 1;
  for (const localFrame of frames.slice(1)) {
    assertActive(request.signal);
    const match = await matchFrame(options, localFrame, predictedX, predictedY, radius);
    if (!match) break;
    processed += 1;
    if (match.confidence >= minConfidence) {
      predictedX = match.x;
      predictedY = match.y;
      lostSamples = 0;
      points.push({ frame: localFrame, x: (match.x + regionWidth / 2) / canvas.width, y: (match.y + regionHeight / 2) / canvas.height, confidence: match.confidence });
    } else lostSamples += 1;
    request.onProgress?.({ processedFrames: processed, totalFrames: frames.length, confidence: match.confidence });
    if (lostSamples >= MAX_LOST_SAMPLES) break;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }
  return { points, processed, lost: lostSamples >= MAX_LOST_SAMPLES };
}

async function analyzeLoadedVideo(video: HTMLVideoElement, request: TrackingRequest): Promise<TrackingResult> {
  const size = analysisSize(video);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const region = regionPixels(request.region, size.width, size.height);
  const frames = sampleFrames(request.durationInFrames);
  const startSeconds = request.srcInFrame / request.fps;
  await seekVideo(video, startSeconds, request.signal);
  const firstFrame = framePixels(video, canvas);
  const template = createGrayTemplate(firstFrame, size.width, region.x, region.y, region.width, region.height);
  if (template.norm < 1) throw new TrackingError('flat-target');

  const tracked = await trackFrameSequence({
    video, canvas, template, frames, request,
    initialX: region.x, initialY: region.y,
    regionWidth: region.width, regionHeight: region.height,
  });

  return {
    points: tracked.points,
    averageConfidence: averageConfidence(tracked.points),
    processedFrames: tracked.processed,
    totalFrames: frames.length,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    stoppedBecauseLost: tracked.lost,
  };
}

function releaseVideo(video: HTMLVideoElement): void {
  video.removeAttribute('src');
  video.load();
}

export async function analyzeMotion(request: TrackingRequest): Promise<TrackingResult> {
  const video = await loadVideo(request.src, request.signal);
  try {
    return await analyzeLoadedVideo(video, request);
  } finally {
    releaseVideo(video);
  }
}
