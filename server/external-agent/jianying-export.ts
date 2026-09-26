// JianYing / CapCut draft export via the open-source capcut-cli (npm, MIT).
// The browser-side agent tool collects the timeline (clip sources, timing,
// captions) and POSTs it here; this module resolves media URLs to local files
// and drives capcut-cli to build a real draft in the CapCut/JianYing store.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ffprobeBin } from '../media-binaries.ts';
import { uploadReadDirs } from '../media-dir.ts';
import { resolveMediaReference } from '../media-references.ts';

/** dev / worktree upload root; isolated profiles read only their own store but
 * dev media commonly lives here too. */
const WORKTREE_UPLOAD_DIR = join(process.cwd(), 'public', 'media', 'uploads');

export interface JianyingExportClip {
  kind: string;
  src: string;
  startFrame: number;
  durationInFrames: number;
  /** Source frame the clip starts reading its media at (the trim in-point). */
  srcInFrame?: number;
  /** Source frames consumed per timeline frame (2 = double speed). */
  playbackRate?: number;
  volume?: number;
  name?: string;
}

export interface JianyingExportCaption {
  startMs: number;
  endMs: number;
  text: string;
}

export interface JianyingExportRequest {
  draftName?: string;
  fps: number;
  items: JianyingExportClip[];
  captions?: JianyingExportCaption[];
  /** Override for the draft store directory (CapCut store by default). */
  draftsDir?: string;
}

/** Runs one capcut-cli command and resolves its JSON output. */
export type CapcutRunner = (args: string[]) => Promise<unknown>;

export interface JianyingExportOptions {
  /** Verification seam: replaces the capcut-cli child process. */
  run?: CapcutRunner;
  /** Verification seam: a media file's duration in µs, null when unreadable. */
  probeDuration?: (file: string) => Promise<number | null>;
}

export interface JianyingExportResult {
  ok: boolean;
  draftName: string;
  draftPath: string;
  addedVideos: number;
  addedAudios: number;
  captions: number;
  warnings: string[];
  error?: string;
}

const DEFAULT_CAPCUT_STORE = join(
  process.env.HOME ?? '',
  'Movies',
  'CapCut',
  'User Data',
  'Projects',
  'com.lveditor.draft',
);

/** Resolve a clip src (/media/uploads/<name> or absolute path) to a local file.
 *  `options.mediaDir` injects an explicit upload root (verification seam). */
export function expandHomeDir(dir: string): string {
  return dir.replace(/^~(?=\/|$)/, process.env.HOME ?? '');
}

export function resolveMediaPath(
  src: string,
  options: { mediaDir?: string } = {},
): string | undefined {
  const clean = String(src || '').trim();
  if (!clean) return undefined;
  if (clean.startsWith('/media/uploads/')) {
    const name = clean.slice('/media/uploads/'.length);
    if (!name || name.includes('/') || name.includes('\\')) return undefined;
    const roots = [...new Set([...uploadReadDirs(undefined, options.mediaDir), WORKTREE_UPLOAD_DIR])];
    for (const dir of roots) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
      // Path imports store a pointer under .references/ when the master stays on
      // disk, so the asset has no copy in uploads. resolveUploadFile follows that
      // pointer; a plain join() would leave those clips "not found locally".
      const referenced = resolveMediaReference(dir, name);
      if (referenced) return referenced;
    }
    return undefined;
  }
  if (existsSync(clean)) return clean;
  return undefined;
}

function capcutBin(): string {
  return process.env.CAPCUT_CLI || 'capcut-cli';
}

function runCapcut(args: string[], timeoutMs = 120_000): Promise<unknown> {
  const executable = capcutBin();
  const prefix = executable.includes('/') || executable.includes('\\')
    ? [executable]
    : ['npx', '--yes', executable];
  return new Promise((resolve, reject) => {
    const child = spawn(prefix[0], [...prefix.slice(1), ...args], {
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`capcut-cli timed out after ${timeoutMs / 1000}s: ${args[0] ?? ''}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`capcut-cli launch failed: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const combined = `${stdout}\n${stderr}`.trim();
      if (code === 0) {
        try {
          const firstJson = combined.split('\n').find((line) => line.trim().startsWith('{'));
          if (firstJson) {
            resolve(JSON.parse(firstJson));
            return;
          }
        } catch {
          /* fall through to raw output */
        }
        resolve({ raw: combined.slice(0, 400) });
        return;
      }
      reject(new Error(`capcut-cli ${args[0] ?? ''} failed (exit ${code}): ${combined.slice(0, 500)}`));
    });
  });
}

const MICROS_PER_SECOND = 1_000_000;

/** capcut-cli keeps whole microseconds; rounding each frame boundary once keeps
 * back-to-back clips edge to edge instead of overlapping by a rounding step. */
function framesToMicros(frames: number, fps: number): number {
  if (!Number.isFinite(frames) || frames <= 0) return 0;
  return Math.round((frames / (fps || 30)) * MICROS_PER_SECOND);
}

/** capcut-cli's parseTimeInput reads a bare number as seconds. */
function secondsArg(micros: number): string {
  return String(micros / MICROS_PER_SECOND);
}

function finiteAtLeast(value: unknown, min: number, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= min ? number : fallback;
}

/** Where a clip lands on the draft timeline and which media span it plays (µs). */
interface ClipTiming {
  start: number;
  duration: number;
  sourceStart: number;
  sourceDuration: number;
  rate: number;
  /** Source cut off because it lay past the end of the file. */
  overrun: number;
}

/** Stills have no source window; only file media is trimmed or retimed. */
function isRetimable(kind: string): boolean {
  return kind === 'video' || kind === 'audio';
}

/** A file's container duration in µs — the figure capcut-cli checks a requested
 * length against — or null when ffprobe cannot read it. */
function probeMediaMicros(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(ffprobeBin(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
      { timeout: 30_000 }, (error, stdout) => {
        const seconds = error ? Number.NaN : Number(String(stdout).trim());
        resolve(Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * MICROS_PER_SECOND) : null);
      });
  });
}

/** null when the clip's in-point lies past the end of its file. */
function clipTiming(clip: JianyingExportClip, fps: number, mediaLength: number | null): ClipTiming | null {
  const startFrame = finiteAtLeast(clip.startFrame, 0, 0);
  const start = framesToMicros(startFrame, fps);
  const duration = Math.max(0, framesToMicros(startFrame + finiteAtLeast(clip.durationInFrames, 0, 0), fps) - start);
  const retimable = isRetimable(clip.kind);
  const requestedRate = retimable ? finiteAtLeast(clip.playbackRate, 0.01, 1) : 1;
  const rate = Math.abs(requestedRate - 1) < 1e-6 ? 1 : requestedRate;
  const sourceStart = retimable ? framesToMicros(finiteAtLeast(clip.srcInFrame, 0, 0), fps) : 0;
  const sourceDuration = Math.round(duration * rate);
  if (mediaLength === null) return { start, duration, sourceStart, sourceDuration, rate, overrun: 0 };
  // Frame counts are rounded from the file's duration, so a clip that runs to
  // its end can overshoot it by up to half a frame. capcut-cli rejects a length
  // more than 10 ms past its own probe, and CapCut replays a source range that
  // overruns its material from 0, so the window stops at the file's end.
  const available = mediaLength - sourceStart;
  if (available <= 0) return null;
  const clamped = Math.min(sourceDuration, available);
  const overrun = sourceDuration - clamped;
  return { start, duration: overrun ? Math.round(clamped / rate) : duration, sourceStart, sourceDuration: clamped, rate, overrun };
}

function isVideoKind(kind: string): boolean {
  return kind === 'video' || kind === 'image' || kind === 'gif';
}

function isAudioKind(kind: string): boolean {
  return kind === 'audio';
}

async function writeSrtFile(captions: JianyingExportCaption[]): Promise<{ file: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'occ-jianying-'));
  const file = join(dir, 'captions.srt');
  const lines: string[] = [];
  captions.forEach((caption, index) => {
    const format = (ms: number): string => {
      const total = Math.max(0, Math.round(ms));
      const h = Math.floor(total / 3_600_000);
      const m = Math.floor((total % 3_600_000) / 60_000);
      const s = Math.floor((total % 60_000) / 1000);
      const milli = total % 1000;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(milli).padStart(3, '0')}`;
    };
    lines.push(`${index + 1}`);
    lines.push(`${format(caption.startMs)} --> ${format(caption.endMs)}`);
    lines.push(caption.text.replace(/\r?\n/g, ' ').trim());
    lines.push('');
  });
  await writeFile(file, lines.join('\n'), 'utf8');
  return { file, dir };
}

interface CapcutOutput {
  ok?: boolean;
  error?: string;
  segment_id?: unknown;
}

/**
 * Add one clip, then move its segment onto the clip's source window.
 *
 * add-video / add-audio place a segment that reads its file from 0, and the
 * duration they take also becomes the material's duration. CapCut plays a
 * segment whose source range runs past its material's duration from 0 whatever
 * start was written (capcut-cli lint: source-range-exceeds-material), so a
 * trimmed or retimed clip is added with its source END as that duration. Then
 * `speed` (keeps the timeline duration, rescales the source span) and last
 * `trim` (sets the source span, derives timeline duration = span / speed).
 * The reverse order would let `speed` rescale the span `trim` just set.
 */
async function addClip(
  run: CapcutRunner,
  command: 'add-video' | 'add-audio',
  draftPath: string,
  file: string,
  timing: ClipTiming,
  storeFlags: string[],
): Promise<{ added: boolean; warning?: string }> {
  const label = `${command} ${basename(file)}`;
  const retimed = timing.sourceStart > 0 || timing.rate !== 1;
  const materialLength = retimed ? timing.sourceStart + timing.sourceDuration : timing.duration;
  const added = await run([command, draftPath, file, secondsArg(timing.start), secondsArg(materialLength), ...storeFlags]) as CapcutOutput;
  if (!added?.ok) return { added: false, warning: `${label}: ${added?.error || 'failed'}` };
  if (!retimed) return { added: true };
  const segmentId = typeof added.segment_id === 'string' ? added.segment_id : '';
  if (!segmentId) {
    return { added: true, warning: `${label}: capcut-cli returned no segment id; the clip plays its source from 0` };
  }
  if (timing.rate !== 1) {
    const sped = await run(['speed', draftPath, segmentId, String(timing.rate), ...storeFlags]) as CapcutOutput;
    if (!sped?.ok) return { added: true, warning: `speed ${basename(file)}: ${sped?.error || 'failed'}` };
  }
  const trimmed = await run([
    'trim', draftPath, segmentId, secondsArg(timing.sourceStart), secondsArg(timing.sourceDuration), ...storeFlags,
  ]) as CapcutOutput;
  if (!trimmed?.ok) return { added: true, warning: `trim ${basename(file)}: ${trimmed?.error || 'failed'}` };
  return { added: true };
}

/**
 * Build a CapCut/JianYing draft from an OpenChatCut timeline using capcut-cli.
 * `init` creates an empty draft; every clip is then added at its timeline
 * position and trimmed to its source window (kept inside its file's probed
 * duration), video first, then audio and captions. (`quickstart --video` always
 * placed its whole file at 0 and reported no segment id, so the first clip could
 * not be positioned or trimmed.)
 */
export async function exportJianyingDraft(
  raw: Partial<JianyingExportRequest>,
  options: JianyingExportOptions = {},
): Promise<JianyingExportResult> {
  const run = options.run ?? runCapcut;
  const probe = options.probeDuration ?? probeMediaMicros;
  const request: JianyingExportRequest = {
    fps: Number(raw.fps) || 30,
    items: Array.isArray(raw.items) ? raw.items.filter((item) => item && typeof item === 'object') : [],
    captions: Array.isArray(raw.captions) ? raw.captions.filter((caption) => caption && typeof caption === 'object') : [],
    draftName: typeof raw.draftName === 'string' ? raw.draftName : undefined,
    draftsDir: typeof raw.draftsDir === 'string' ? raw.draftsDir : undefined,
  };
  const warnings: string[] = [];
  const fps = finiteAtLeast(request.fps, 1, 30);
  const videos = request.items.filter((item) => isVideoKind(item.kind));
  const audios = request.items.filter((item) => isAudioKind(item.kind));
  if (videos.length === 0) {
    return { ok: false, draftName: '', draftPath: '', addedVideos: 0, addedAudios: 0, captions: 0, warnings, error: 'timeline has no video clips to export' };
  }
  const resolved = videos.map((clip) => ({ clip, file: resolveMediaPath(clip.src) }));
  const missing = resolved.filter((entry) => !entry.file).map((entry) => entry.clip.src);
  if (missing.length > 0) {
    return { ok: false, draftName: '', draftPath: '', addedVideos: 0, addedAudios: 0, captions: 0, warnings, error: `media files not found locally: ${missing.slice(0, 3).join(', ')}` };
  }
  const draftName = String(request.draftName || `OpenChatCut-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`)
    .replace(/[\\/]/g, '')
    .replaceAll('\0', '')
    .slice(0, 60);
  if (!draftName) {
    return { ok: false, draftName: '', draftPath: '', addedVideos: 0, addedAudios: 0, captions: 0, warnings, error: 'invalid draft name' };
  }
  const draftsDir = expandHomeDir(String(request.draftsDir || '').trim())
    || DEFAULT_CAPCUT_STORE;
  const storeFlags = ['--jianying', '--force-write', '--drafts', draftsDir];
  const created = await run(['init', draftName, ...storeFlags]) as { ok?: boolean; draft_path?: string; error?: string };
  if (!created?.ok || !created.draft_path) {
    return { ok: false, draftName, draftPath: '', addedVideos: 0, addedAudios: 0, captions: 0, warnings, error: created?.error || 'capcut-cli init failed' };
  }
  const draftPath = created.draft_path;
  // One probe per file, however many clips cut it.
  const mediaLengths = new Map<string, Promise<number | null>>();
  const lengthOf = (file: string): Promise<number | null> => {
    const known = mediaLengths.get(file);
    if (known) return known;
    const probed = probe(file);
    mediaLengths.set(file, probed);
    return probed;
  };
  const place = async (command: 'add-video' | 'add-audio', file: string, clip: JianyingExportClip): Promise<boolean> => {
    const timing = clipTiming(clip, fps, isRetimable(clip.kind) ? await lengthOf(file) : null);
    const label = `${command} ${basename(file)}`;
    if (!timing) {
      warnings.push(`${label}: in-point is past the end of the file`);
      return false;
    }
    // Nothing to place, and a missing length would make capcut-cli take the whole file.
    if (timing.duration <= 0 || timing.sourceDuration <= 0) return false;
    // Less than a frame is frame rounding; more means the clip outlasts its file.
    if (timing.overrun >= MICROS_PER_SECOND / fps) {
      warnings.push(`${label}: runs ${secondsArg(timing.overrun)} s past the end of the file; cut at its end`);
    }
    const outcome = await addClip(run, command, draftPath, file, timing, storeFlags);
    if (outcome.warning) warnings.push(outcome.warning);
    return outcome.added;
  };
  let addedVideos = 0;
  for (const entry of resolved) {
    if (await place('add-video', entry.file as string, entry.clip)) addedVideos += 1;
  }
  let addedAudios = 0;
  for (const clip of audios) {
    const file = resolveMediaPath(clip.src);
    if (!file) {
      warnings.push(`audio not found locally: ${clip.src}`);
      continue;
    }
    if (await place('add-audio', file, clip)) addedAudios += 1;
  }
  let captions = 0;
  const captionList = (request.captions ?? []).filter((caption) => caption.text.trim() && caption.endMs > caption.startMs);
  if (captionList.length > 0) {
    const { file, dir } = await writeSrtFile(captionList);
    try {
      const result = await run(['import-srt', draftPath, file, ...storeFlags]) as { ok?: boolean; error?: string };
      if (result?.ok) captions = captionList.length;
      else warnings.push(`import-srt: ${result?.error || 'failed'}`);
    } finally {
      void rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return { ok: true, draftName, draftPath, addedVideos, addedAudios, captions, warnings };
}
