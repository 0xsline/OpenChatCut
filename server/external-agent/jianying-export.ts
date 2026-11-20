// JianYing / CapCut draft export via the open-source capcut-cli (npm, MIT).
// The browser-side agent tool collects the timeline (clip sources, timing,
// captions) and POSTs it here; this module resolves media URLs to local files
// and drives capcut-cli to build a real draft in the CapCut/JianYing store.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, posix, win32 } from 'node:path';
import { sanitizeFileName } from '../file-name.ts';
import { ffprobeBin } from '../media-binaries.ts';
import { uploadReadDirs } from '../media-dir.ts';
import { resolveMediaReference } from '../media-references.ts';
import { resolveProductAsset } from '../product-assets.ts';
import type { AspectFit, TimelineItem, TimelineState } from '../../src/editor/types.ts';
import { capcutLaunch } from './capcut-command.ts';

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
  trackName?: string;
  layer?: number;
  graphic?: { item: TimelineItem; width: number; height: number; fit?: AspectFit };
}

export interface JianyingExportCaption {
  startMs: number;
  endMs: number;
  text: string;
  trackName?: string;
}

/** An app whose default draft store the server knows on its own platform. */
export type JianyingDraftStoreName = 'capcut' | 'jianying';

export interface JianyingExportRequest {
  draftName?: string;
  fps: number;
  width?: number;
  height?: number;
  items: JianyingExportClip[];
  captions?: JianyingExportCaption[];
  /** Whose default store to write to when no draftsDir is given (CapCut's by default). */
  store?: JianyingDraftStoreName;
  /** Override for the draft store directory. */
  draftsDir?: string;
}

/** Runs one capcut-cli command and resolves its JSON output. */
export type CapcutRunner = (args: string[]) => Promise<unknown>;

export interface JianyingExportOptions {
  /** Verification seam: replaces the capcut-cli child process. */
  run?: CapcutRunner;
  /** Verification seam: a media file's duration in µs, null when unreadable. */
  probeDuration?: (file: string) => Promise<number | null>;
  /** Verification seams: the machine whose store and file-name rules apply. */
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Verification seam for the packaged Remotion alpha renderer. */
  renderGraphic?: (state: TimelineState, dest: string) => Promise<void>;
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

/**
 * Where CapCut and JianYing keep their drafts unless moved in their settings,
 * as capcut-cli 0.26 locates them (draftDirCandidates): under %LOCALAPPDATA% on
 * Windows, where HOME is usually unset, and under ~/Movies on macOS (and, with
 * no desktop app to follow, on Linux too).
 */
function defaultDraftStore(
  store: JianyingDraftStoreName,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  const app = store === 'jianying' ? 'JianyingPro' : 'CapCut';
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || win32.join(env.USERPROFILE || home, 'AppData', 'Local');
    return win32.join(localAppData, app, 'User Data', 'Projects', 'com.lveditor.draft');
  }
  return posix.join(home, 'Movies', app, 'User Data', 'Projects', 'com.lveditor.draft');
}

/** `~` or `~/…` (on Windows also `~\…`) in a store path → the account's home,
 * from os.homedir() rather than HOME, which Windows does not set. */
export function expandHomeDir(dir: string, platform = process.platform, home = homedir()): string {
  const tilde = platform === 'win32' ? /^~(?=[\\/]|$)/ : /^~(?=\/|$)/;
  return dir.replace(tilde, () => home);
}

// Device names Windows reserves, alone or before an extension (NUL.txt is NUL).
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;

/** A draft name as a Windows folder name. Node creates `Final cut.` or `CON`
 * through \\?\ paths, but Win32 path parsing (CapCut, JianYing, Explorer)
 * drops a trailing dot or space and maps device names, so the draft would not
 * open. Trim after the length cut, which can end on a space. */
function windowsFolderName(name: string): string {
  const folder = sanitizeFileName(name, '').slice(0, 60).replace(/[. ]+$/, '');
  return WINDOWS_RESERVED_NAME.test(folder) ? `_${folder}` : folder;
}

/** Resolve a clip src (/media/uploads/<name> or absolute path) to a local file.
 *  `options.mediaDir` injects an explicit upload root (verification seam). */
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
  if (clean.startsWith('/')) {
    const productAsset = resolveProductAsset(clean);
    if (productAsset) return productAsset;
  }
  if (existsSync(clean)) return clean;
  return undefined;
}

/** Runs one capcut-cli command, never through a shell of ours (capcut-command.ts). */
function runCapcut(args: string[], timeoutMs = 120_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // Use one probe for source-window validation and the CLI's duration/dimensions.
    // Different FFmpeg versions can disagree on the padding of short MP3s.
    const mediaCommand = args[0] === 'add-video' || args[0] === 'add-audio';
    const launch = capcutLaunch(mediaCommand ? [...args, '--ffprobe-cmd', ffprobeBin()] : args);
    const child = spawn(launch.executable, launch.args, {
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Every call is a console process; unhidden, each would flash a window over the Windows app.
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`capcut-cli timed out after ${timeoutMs / 1000}s: ${args[0] ?? ''}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const hint = error.code === 'ENOENT' && launch.executable === 'npx'
        ? ' (capcut-cli runs through npx: install Node.js, or set CAPCUT_CLI)'
        : '';
      reject(new Error(`capcut-cli launch failed: ${error.message}${hint}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const combined = `${stdout}\n${stderr}`.trim();
      try {
        const firstJson = combined.split('\n').find((line) => line.trim().startsWith('{'));
        if (firstJson) {
          const result = JSON.parse(firstJson);
          if (code === 0 || typeof result?.error === 'string') {
            resolve(code === 0 ? result : { ...result, ok: false });
            return;
          }
        }
      } catch {
        /* fall through to raw output */
      }
      if (code === 0) {
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

async function writeSrtFile(captions: JianyingExportCaption[], portrait: boolean): Promise<{ file: string; dir: string }> {
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
    const content = caption.text.replace(/\r?\n/g, ' ').trim();
    // The draft builder does not wrap text to the canvas width. Give long
    // portrait cues explicit lines so the editor can still treat each as one cue.
    if (portrait) {
      const characters = Array.from(content);
      for (let offset = 0; offset < characters.length; offset += 20) {
        lines.push(characters.slice(offset, offset + 20).join(''));
      }
    } else {
      lines.push(content);
    }
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
  clip: JianyingExportClip,
): Promise<{ added: boolean; warning?: string }> {
  const label = `${command} ${basename(file)}`;
  const retimed = timing.sourceStart > 0 || timing.rate !== 1;
  const materialLength = retimed ? timing.sourceStart + timing.sourceDuration : timing.duration;
  const volume = typeof clip.volume === 'number' && Number.isFinite(clip.volume)
    ? Math.max(0, Math.min(1, clip.volume)) : undefined;
  const trackFlags = clip.trackName ? ['--track-name', clip.trackName] : [];
  const audioFlags = command === 'add-audio' && volume !== undefined ? ['--volume', String(volume)] : [];
  const added = await run([
    command, draftPath, file, secondsArg(timing.start), secondsArg(materialLength),
    ...trackFlags, ...audioFlags, ...storeFlags,
  ]) as CapcutOutput;
  if (!added?.ok) return { added: false, warning: `${label}: ${added?.error || 'failed'}` };
  const adjustVideoVolume = command === 'add-video' && volume !== undefined && volume !== 1;
  if (!retimed && !adjustVideoVolume) return { added: true };
  const segmentId = typeof added.segment_id === 'string' ? added.segment_id : '';
  if (!segmentId) {
    const consequence = retimed ? 'the clip plays its source from 0' : 'volume was not applied';
    return { added: true, warning: `${label}: capcut-cli returned no segment id; ${consequence}` };
  }
  if (timing.rate !== 1) {
    const sped = await run(['speed', draftPath, segmentId, String(timing.rate), ...storeFlags]) as CapcutOutput;
    if (!sped?.ok) return { added: true, warning: `speed ${basename(file)}: ${sped?.error || 'failed'}` };
  }
  if (retimed) {
    const trimmed = await run([
      'trim', draftPath, segmentId, secondsArg(timing.sourceStart), secondsArg(timing.sourceDuration), ...storeFlags,
    ]) as CapcutOutput;
    if (!trimmed?.ok) return { added: true, warning: `trim ${basename(file)}: ${trimmed?.error || 'failed'}` };
  }
  if (adjustVideoVolume) {
    const adjusted = await run(['volume', draftPath, segmentId, String(volume), ...storeFlags]) as CapcutOutput;
    if (!adjusted?.ok) return { added: true, warning: `volume ${basename(file)}: ${adjusted?.error || 'failed'}` };
  }
  return { added: true };
}

async function renderGraphic(state: TimelineState, outputLocation: string): Promise<void> {
  const { renderClip } = await import('../plugins/export-rendering.ts');
  const { withExportPermit } = await import('../plugins/export-runtime.ts');
  const { acceptExportSubmission } = await import('../plugins/export-submission.ts');
  const accepted = await acceptExportSubmission({ state });
  try {
    await withExportPermit(() => renderClip({ state: accepted.plan.state, outputLocation, codec: 'prores', transparent: true }));
  } finally {
    await accepted.cleanup();
  }
}

/** Named video tracks are created bottom-up by capcut-cli in insertion order. */
function layerOrder(a: JianyingExportClip, b: JianyingExportClip): number {
  return (a.layer ?? 0) - (b.layer ?? 0);
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
  const hasGraphics = Array.isArray(raw.items) && raw.items.some((item) => item?.kind === 'graphic');
  const temporary = hasGraphics ? await mkdtemp(join(tmpdir(), 'occ-jianying-graphics-')) : undefined;
  try {
    return await writeDraft(raw, options, temporary);
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

async function writeDraft(
  raw: Partial<JianyingExportRequest>,
  options: JianyingExportOptions,
  temporary: string | undefined,
): Promise<JianyingExportResult> {
  const run = options.run ?? runCapcut;
  const probe = options.probeDuration ?? probeMediaMicros;
  const { platform = process.platform, env = process.env, home = homedir() } = options;
  const request: JianyingExportRequest = {
    fps: Number(raw.fps) || 30,
    width: raw.width,
    height: raw.height,
    items: Array.isArray(raw.items) ? raw.items.filter((item) => item && typeof item === 'object') : [],
    captions: Array.isArray(raw.captions) ? raw.captions.filter((caption) => caption && typeof caption === 'object') : [],
    draftName: typeof raw.draftName === 'string' ? raw.draftName : undefined,
    store: raw.store === 'jianying' ? 'jianying' : 'capcut',
    draftsDir: typeof raw.draftsDir === 'string' ? raw.draftsDir : undefined,
  };
  const warnings: string[] = [];
  const fps = finiteAtLeast(request.fps, 1, 30);
  const videos = request.items.filter((item) => isVideoKind(item.kind));
  const graphics = request.items.filter((item) => item.kind === 'graphic');
  const audios = request.items.filter((item) => isAudioKind(item.kind));
  if (videos.length === 0 && graphics.length === 0) {
    return { ok: false, draftName: '', draftPath: '', addedVideos: 0, addedAudios: 0, captions: 0, warnings, error: 'timeline has no video clips to export' };
  }
  const resolved = videos.map((clip) => ({ clip, file: resolveMediaPath(clip.src) }));
  const missing = resolved.filter((entry) => !entry.file).map((entry) => entry.clip.src);
  if (missing.length > 0) {
    return { ok: false, draftName: '', draftPath: '', addedVideos: 0, addedAudios: 0, captions: 0, warnings, error: `media files not found locally: ${missing.slice(0, 3).join(', ')}` };
  }
  for (const [index, clip] of graphics.entries()) {
    const graphic = clip.graphic;
    if (!temporary || !graphic || !graphic.item ||
        !['motion-graphic', 'solid'].includes(graphic.item.kind) ||
        !Number.isSafeInteger(graphic.width) || !Number.isSafeInteger(graphic.height) ||
        graphic.width <= 0 || graphic.height <= 0 || graphic.width > 8192 || graphic.height > 8192 ||
        !Number.isSafeInteger(graphic.item.durationInFrames) || graphic.item.durationInFrames <= 0) {
      warnings.push(`${clip.name ?? 'Graphic'}: invalid graphic render request`);
      continue;
    }
    const name = sanitizeFileName(clip.name ?? '', 'graphic').slice(0, 64);
    const file = join(temporary, `${index + 1}-${name}.mov`);
    try {
      await (options.renderGraphic ?? renderGraphic)({
        width: graphic.width, height: graphic.height, fps, fit: graphic.fit, selectedId: null,
        items: [{ ...graphic.item, startFrame: 0 }],
      }, file);
      resolved.push({ clip: { ...clip, kind: 'video', volume: 0 }, file });
    } catch (error) {
      warnings.push(`${clip.name ?? 'Graphic'}: ${error instanceof Error ? error.message : 'graphic render failed'}`);
    }
  }
  if (resolved.length === 0) {
    return { ok: false, draftName: '', draftPath: '', addedVideos: 0, addedAudios: 0, captions: 0, warnings, error: warnings.join('; ') || 'No graphics could be rendered' };
  }
  resolved.sort((a, b) => layerOrder(a.clip, b.clip));
  audios.sort(layerOrder);
  const named = String(request.draftName || `OpenChatCut-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`)
    .replace(/[\\/]/g, '')
    .replaceAll('\0', '');
  // The name becomes a folder. Windows forbids : * ? " < > | and control
  // characters there, so the shared file-name rule replaces them, which also
  // keeps quotes and line breaks away from a .cmd CAPCUT_CLI's cmd.exe hop.
  const draftName = platform === 'win32' ? windowsFolderName(named) : named.slice(0, 60);
  if (!draftName) {
    return { ok: false, draftName: '', draftPath: '', addedVideos: 0, addedAudios: 0, captions: 0, warnings, error: 'invalid draft name' };
  }
  const draftsDir = expandHomeDir(String(request.draftsDir || '').trim(), platform, home)
    || defaultDraftStore(request.store ?? 'capcut', platform, env, home);
  const storeFlags = ['--jianying', '--force-write', '--drafts', draftsDir];
  const { width, height } = request;
  const canvas = width && height && Number.isSafeInteger(width) && Number.isSafeInteger(height)
    && width > 0 && height > 0 ? ['--width', String(width), '--height', String(height)] : [];
  const portrait = Boolean(width && height && width < height);
  const captionStyle = canvas.length ? [
    '--font-size', portrait ? '7.5' : '10', '--y', '-0.72',
    '--bg-color', '#000000', '--bg-alpha', '0.8', '--bg-style', '1',
    '--bg-round-radius', '0.1', '--bg-width', '0.14', '--bg-height', '0.14',
  ] : [];
  const created = await run(['init', draftName, ...canvas, ...storeFlags]) as { ok?: boolean; draft_path?: string; error?: string };
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
    const outcome = await addClip(run, command, draftPath, file, timing, storeFlags, clip);
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
  const captionTracks = new Map<string, JianyingExportCaption[]>();
  for (const caption of request.captions ?? []) {
    if (typeof caption.text !== 'string' || !caption.text.trim() || !(caption.endMs > caption.startMs)) continue;
    const trackName = caption.trackName || '';
    const track = captionTracks.get(trackName) ?? [];
    track.push(caption);
    captionTracks.set(trackName, track);
  }
  for (const [trackName, captionList] of captionTracks) {
    const { file, dir } = await writeSrtFile(captionList, portrait);
    try {
      const trackFlags = trackName ? ['--track-name', trackName] : [];
      const result = await run(['import-srt', draftPath, file, ...trackFlags, ...captionStyle, ...storeFlags]) as { ok?: boolean; error?: string };
      if (result?.ok) captions += captionList.length;
      else warnings.push(`import-srt: ${result?.error || 'failed'}`);
    } finally {
      void rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return { ok: true, draftName, draftPath, addedVideos, addedAudios, captions, warnings };
}
