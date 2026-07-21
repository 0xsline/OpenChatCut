interface TimelineQaState {
  fps: number;
  width: number;
  height: number;
  items: Array<{
    id: string;
    track: string;
    startFrame: number;
    durationInFrames: number;
    kind: string;
    volume?: number;
  }>;
  tracks?: Record<string, { kind?: 'video' | 'audio'; hidden?: boolean; muted?: boolean } | undefined>;
}

function qaTrackKind(state: TimelineQaState, track: string): 'video' | 'audio' {
  return state.tracks?.[track]?.kind ?? (track.toUpperCase().startsWith('A') ? 'audio' : 'video');
}

function qaTimelineDuration(state: TimelineQaState): number {
  const end = state.items.reduce(
    (maximum, item) => Math.max(maximum, item.startFrame + item.durationInFrames),
    0,
  );
  return Math.max(end, state.fps);
}

export type ExportQaSeverity = 'error' | 'warning';

export interface ExportQaInterval {
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
}

export interface ExportQaIssue {
  code: string;
  severity: ExportQaSeverity;
  message: string;
  startSeconds?: number;
  endSeconds?: number;
}

export interface ExportQaAnalysis {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  blackFrames: ExportQaInterval[];
  frozenFrames: ExportQaInterval[];
  silence: ExportQaInterval[];
  meanVolumeDb?: number;
  maxVolumeDb?: number;
}

export interface ExportQaExpectations {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  expectsAudio: boolean;
}

export interface ExportQaReport extends ExportQaAnalysis {
  ok: boolean;
  issues: ExportQaIssue[];
  summary: {
    errors: number;
    warnings: number;
  };
}

const rounded = (value: number, digits = 3): number => Number(value.toFixed(digits));

function interval(start: number, end: number): ExportQaInterval | null {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return {
    startSeconds: rounded(start),
    endSeconds: rounded(end),
    durationSeconds: rounded(end - start),
  };
}

/** Parse the stable key/value messages emitted by FFmpeg analysis filters. */
export function parseExportQaLog(log: string): Pick<
  ExportQaAnalysis,
  'blackFrames' | 'frozenFrames' | 'silence' | 'meanVolumeDb' | 'maxVolumeDb'
> {
  const blackFrames: ExportQaInterval[] = [];
  const frozenFrames: ExportQaInterval[] = [];
  const silence: ExportQaInterval[] = [];

  for (const match of log.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)) {
    const value = interval(Number(match[1]), Number(match[2]));
    if (value) blackFrames.push(value);
  }

  const freezeStarts: number[] = [];
  for (const line of log.split(/\r?\n/)) {
    const start = line.match(/freeze_start:\s*([\d.]+)/);
    if (start) freezeStarts.push(Number(start[1]));
    const end = line.match(/freeze_end:\s*([\d.]+)(?:\s*\|\s*freeze_duration:\s*([\d.]+))?/);
    if (end && freezeStarts.length) {
      const value = interval(freezeStarts.shift()!, Number(end[1]));
      if (value) frozenFrames.push(value);
    }
  }

  let silenceStart: number | null = null;
  for (const line of log.split(/\r?\n/)) {
    const start = line.match(/silence_start:\s*([\d.]+)/);
    if (start) silenceStart = Number(start[1]);
    const end = line.match(/silence_end:\s*([\d.]+)(?:\s*\|\s*silence_duration:\s*([\d.]+))?/);
    if (end && silenceStart != null) {
      const value = interval(silenceStart, Number(end[1]));
      if (value) silence.push(value);
      silenceStart = null;
    }
  }

  const mean = [...log.matchAll(/mean_volume:\s*(-?(?:inf|[\d.]+))\s*dB/gi)].at(-1)?.[1];
  const max = [...log.matchAll(/max_volume:\s*(-?(?:inf|[\d.]+))\s*dB/gi)].at(-1)?.[1];
  const parseDb = (value?: string): number | undefined => {
    if (!value || /^-?inf$/i.test(value)) return undefined;
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  };

  return {
    blackFrames,
    frozenFrames,
    silence,
    meanVolumeDb: parseDb(mean),
    maxVolumeDb: parseDb(max),
  };
}

/** Turn media measurements into a conservative, structured acceptance report. */
export function assessExportQuality(
  analysis: ExportQaAnalysis,
  expected: ExportQaExpectations,
): ExportQaReport {
  const issues: ExportQaIssue[] = [];
  const add = (issue: ExportQaIssue) => issues.push(issue);

  if (!analysis.hasVideo) {
    add({ code: 'missing_video', severity: 'error', message: 'The exported file has no video stream.' });
  }

  const durationTolerance = Math.max(0.25, 2 / Math.max(1, expected.fps));
  const durationDelta = Math.abs(analysis.durationSeconds - expected.durationSeconds);
  if (durationDelta > durationTolerance) {
    add({
      code: 'duration_mismatch',
      severity: 'error',
      message: `Export duration differs by ${durationDelta.toFixed(2)}s (expected ${expected.durationSeconds.toFixed(2)}s, got ${analysis.durationSeconds.toFixed(2)}s).`,
    });
  }

  if (analysis.hasVideo && (analysis.width !== expected.width || analysis.height !== expected.height)) {
    add({
      code: 'resolution_mismatch',
      severity: 'error',
      message: `Export resolution is ${analysis.width}×${analysis.height}; expected ${expected.width}×${expected.height}.`,
    });
  }

  if (analysis.hasVideo && Math.abs(analysis.fps - expected.fps) > 0.5) {
    add({
      code: 'fps_mismatch',
      severity: 'warning',
      message: `Export frame rate is ${analysis.fps.toFixed(2)} fps; expected ${expected.fps.toFixed(2)} fps.`,
    });
  }

  if (expected.expectsAudio && !analysis.hasAudio) {
    add({ code: 'missing_audio', severity: 'error', message: 'The timeline contains audible media but the export has no audio stream.' });
  }

  for (const black of analysis.blackFrames.filter((value) => value.durationSeconds >= 0.2)) {
    const atEdge = black.startSeconds <= 0.08 || black.endSeconds >= analysis.durationSeconds - 0.08;
    if (!atEdge || black.durationSeconds >= 0.75) {
      add({
        code: 'black_frames',
        severity: black.durationSeconds >= 1 ? 'error' : 'warning',
        message: `Black frames detected for ${black.durationSeconds.toFixed(2)}s.`,
        startSeconds: black.startSeconds,
        endSeconds: black.endSeconds,
      });
    }
  }

  for (const frozen of analysis.frozenFrames.filter((value) => value.durationSeconds >= 0.75)) {
    add({
      code: 'frozen_frames',
      severity: frozen.durationSeconds >= 3 ? 'error' : 'warning',
      message: `A still/frozen span lasts ${frozen.durationSeconds.toFixed(2)}s; verify that it is intentional.`,
      startSeconds: frozen.startSeconds,
      endSeconds: frozen.endSeconds,
    });
  }

  if (expected.expectsAudio) {
    for (const silent of analysis.silence.filter((value) => value.durationSeconds >= 3)) {
      const atEdge = silent.startSeconds <= 0.1 || silent.endSeconds >= analysis.durationSeconds - 0.1;
      if (!atEdge || silent.durationSeconds >= 5) {
        add({
          code: 'long_silence',
          severity: 'warning',
          message: `Audio is silent for ${silent.durationSeconds.toFixed(2)}s; verify that the gap is intentional.`,
          startSeconds: silent.startSeconds,
          endSeconds: silent.endSeconds,
        });
      }
    }
  }

  if (analysis.maxVolumeDb != null && analysis.maxVolumeDb >= -0.1) {
    add({
      code: 'audio_peak',
      severity: 'warning',
      message: `Audio peaks at ${analysis.maxVolumeDb.toFixed(1)} dBFS and may clip after platform transcoding.`,
    });
  }

  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const warnings = issues.length - errors;
  return { ...analysis, ok: errors === 0, issues, summary: { errors, warnings } };
}

/** Adjacent visual clip boundaries worth inspecting in the final render. */
export function timelineCutTimesSeconds(state: TimelineQaState, maxCuts = 12): number[] {
  const fps = Math.max(1, state.fps);
  const cuts: number[] = [];
  const trackIds = new Set(state.items.map((item) => item.track));
  for (const track of trackIds) {
    if (qaTrackKind(state, track) !== 'video' || state.tracks?.[track]?.hidden) continue;
    const items = state.items
      .filter((item) => item.track === track && item.kind !== 'audio')
      .sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id));
    for (let index = 1; index < items.length; index += 1) {
      const previous = items[index - 1]!;
      const current = items[index]!;
      const gap = current.startFrame - (previous.startFrame + previous.durationInFrames);
      if (Math.abs(gap) <= 1) cuts.push(current.startFrame / fps);
    }
  }
  return [...new Set(cuts.map((value) => rounded(value, 4)))]
    .sort((a, b) => a - b)
    .slice(0, Math.max(1, Math.min(24, Math.round(maxCuts))));
}

export function exportQaExpectations(state: TimelineQaState): ExportQaExpectations {
  const audibleItems = state.items.filter((item) => {
    const track = state.tracks?.[item.track];
    return !track?.hidden
      && !track?.muted
      && (item.kind === 'audio' || item.kind === 'video')
      && (item.volume ?? 1) > 0;
  });
  return {
    durationSeconds: qaTimelineDuration(state) / Math.max(1, state.fps),
    width: state.width,
    height: state.height,
    fps: state.fps,
    expectsAudio: audibleItems.length > 0,
  };
}
