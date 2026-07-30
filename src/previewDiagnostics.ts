import { useEffect, useState, type RefObject } from 'react';
import { activeGlRuntimeCount } from './gl/runtime';

const RAF_GAP_THRESHOLD_MS = 50;
const SNAPSHOT_INTERVAL_MS = 500;

type FrameMetadata = { presentedFrames: number; processingDuration?: number };
type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: FrameMetadata) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
  getVideoPlaybackQuality?: () => { droppedVideoFrames: number };
};

interface VideoSample {
  frameHandle: number | null;
  lastPresented: number | null;
  lastDropped: number | null;
}

export interface PreviewDiagnosticsSnapshot {
  rafGapCount: number;
  longestRafGapMs: number;
  presentedVideoFrames: number;
  droppedVideoFrames: number;
  processingDurationMs: number | null;
  longAnimationFrameSupported: boolean;
  longAnimationFrameCount: number;
  longTaskSupported: boolean;
  longTaskCount: number;
  activeMediaElements: number;
  canvasElements: number;
  activeWebGlRuntimes: number;
  previewBackingPixels: number;
}

function supportedEntryTypes(): ReadonlySet<string> {
  if (typeof PerformanceObserver === 'undefined') return new Set();
  return new Set(PerformanceObserver.supportedEntryTypes ?? []);
}

function activeMediaCount(): number {
  return [...document.querySelectorAll<HTMLMediaElement>('video, audio')]
    .filter((media) => media.isConnected && !media.paused && !media.ended && media.readyState >= 2)
    .length;
}

function previewBackingPixels(root: HTMLElement): number {
  const mediaPixels = [...root.querySelectorAll<HTMLVideoElement>('video')]
    .reduce((total, video) => total + video.videoWidth * video.videoHeight, 0);
  const canvasPixels = [...root.querySelectorAll<HTMLCanvasElement>('canvas')]
    .reduce((total, canvas) => total + canvas.width * canvas.height, 0);
  return mediaPixels + canvasPixels;
}

class PreviewDiagnosticsCollector {
  private readonly samples = new Map<FrameVideo, VideoSample>();
  private readonly observers: PerformanceObserver[] = [];
  private readonly support = supportedEntryTypes();
  private mutationObserver: MutationObserver | null = null;
  private rafHandle = 0;
  private lastRafAt = performance.now();
  private lastSnapshotAt = 0;
  private rafGapCount = 0;
  private longestRafGapMs = 0;
  private presentedVideoFrames = 0;
  private droppedVideoFrames = 0;
  private processingDurationMs: number | null = null;
  private longAnimationFrameCount = 0;
  private longTaskCount = 0;
  private readonly root: HTMLElement;
  private readonly onSnapshot: (snapshot: PreviewDiagnosticsSnapshot) => void;

  constructor(root: HTMLElement, onSnapshot: (snapshot: PreviewDiagnosticsSnapshot) => void) {
    this.root = root;
    this.onSnapshot = onSnapshot;
  }

  start(): void {
    this.syncVideos();
    this.mutationObserver = new MutationObserver(() => this.syncVideos());
    this.mutationObserver.observe(this.root, { childList: true, subtree: true });
    this.observePerformance('long-animation-frame', () => { this.longAnimationFrameCount += 1; });
    this.observePerformance('longtask', () => { this.longTaskCount += 1; });
    this.rafHandle = requestAnimationFrame(this.tick);
  }

  stop(): void {
    cancelAnimationFrame(this.rafHandle);
    this.mutationObserver?.disconnect();
    for (const observer of this.observers) observer.disconnect();
    for (const video of this.samples.keys()) this.detachVideo(video);
    this.samples.clear();
  }

  private observePerformance(type: string, onEntry: () => void): void {
    if (!this.support.has(type)) return;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const _entry of list.getEntries()) onEntry();
      });
      observer.observe({ type, buffered: false });
      this.observers.push(observer);
    } catch {
      // Support detection is reported independently; observation failure stays non-fatal.
    }
  }

  private syncVideos(): void {
    const current = new Set(this.root.querySelectorAll<FrameVideo>('video'));
    for (const video of current) if (!this.samples.has(video)) this.attachVideo(video);
    for (const video of this.samples.keys()) if (!current.has(video)) this.detachVideo(video);
  }

  private attachVideo(video: FrameVideo): void {
    const sample: VideoSample = { frameHandle: null, lastPresented: null, lastDropped: null };
    this.samples.set(video, sample);
    this.scheduleVideoFrame(video, sample);
  }

  private detachVideo(video: FrameVideo): void {
    const sample = this.samples.get(video);
    if (sample?.frameHandle != null) video.cancelVideoFrameCallback?.(sample.frameHandle);
    this.samples.delete(video);
  }

  private scheduleVideoFrame(video: FrameVideo, sample: VideoSample): void {
    if (!video.requestVideoFrameCallback) return;
    sample.frameHandle = video.requestVideoFrameCallback((_now, metadata) => {
      sample.frameHandle = null;
      if (sample.lastPresented !== null) {
        const delta = metadata.presentedFrames >= sample.lastPresented
          ? metadata.presentedFrames - sample.lastPresented : metadata.presentedFrames;
        this.presentedVideoFrames += Math.max(0, delta);
      }
      sample.lastPresented = metadata.presentedFrames;
      if (Number.isFinite(metadata.processingDuration)) {
        this.processingDurationMs = metadata.processingDuration! * 1000;
      }
      if (this.samples.has(video)) this.scheduleVideoFrame(video, sample);
    });
  }

  private sampleDroppedFrames(): void {
    for (const [video, sample] of this.samples) {
      if (typeof video.getVideoPlaybackQuality !== 'function') continue;
      const dropped = video.getVideoPlaybackQuality().droppedVideoFrames;
      if (sample.lastDropped !== null) {
        const delta = dropped >= sample.lastDropped ? dropped - sample.lastDropped : dropped;
        this.droppedVideoFrames += Math.max(0, delta);
      }
      sample.lastDropped = dropped;
    }
  }

  private readonly tick = (now: number): void => {
    const gap = now - this.lastRafAt;
    this.lastRafAt = now;
    if (gap > RAF_GAP_THRESHOLD_MS) {
      this.rafGapCount += 1;
      this.longestRafGapMs = Math.max(this.longestRafGapMs, gap);
    }
    if (now - this.lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) {
      this.lastSnapshotAt = now;
      this.sampleDroppedFrames();
      this.onSnapshot(this.snapshot());
    }
    this.rafHandle = requestAnimationFrame(this.tick);
  };

  private snapshot(): PreviewDiagnosticsSnapshot {
    return {
      rafGapCount: this.rafGapCount,
      longestRafGapMs: this.longestRafGapMs,
      presentedVideoFrames: this.presentedVideoFrames,
      droppedVideoFrames: this.droppedVideoFrames,
      processingDurationMs: this.processingDurationMs,
      longAnimationFrameSupported: this.support.has('long-animation-frame'),
      longAnimationFrameCount: this.longAnimationFrameCount,
      longTaskSupported: this.support.has('longtask'),
      longTaskCount: this.longTaskCount,
      activeMediaElements: activeMediaCount(),
      canvasElements: document.querySelectorAll('canvas').length,
      activeWebGlRuntimes: activeGlRuntimeCount(),
      previewBackingPixels: previewBackingPixels(this.root),
    };
  }
}

export function usePreviewDiagnostics(
  rootRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): PreviewDiagnosticsSnapshot | null {
  const [snapshot, setSnapshot] = useState<PreviewDiagnosticsSnapshot | null>(null);
  useEffect(() => {
    if (!enabled || !rootRef.current) {
      setSnapshot(null);
      return;
    }
    const collector = new PreviewDiagnosticsCollector(rootRef.current, setSnapshot);
    collector.start();
    return () => collector.stop();
  }, [enabled, rootRef]);
  return snapshot;
}
