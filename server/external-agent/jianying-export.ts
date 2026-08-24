// JianYing / CapCut draft export via the open-source capcut-cli (npm, MIT).
// The browser-side agent tool collects the timeline (clip sources, timing,
// captions) and POSTs it here; this module resolves media URLs to local files
// and drives capcut-cli to build a real draft in the CapCut/JianYing store.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { uploadReadDirs } from '../media-dir.ts';

/** dev / worktree upload root; isolated profiles read only their own store but
 * dev media commonly lives here too. */
const WORKTREE_UPLOAD_DIR = join(process.cwd(), 'public', 'media', 'uploads');

export interface JianyingExportClip {
  kind: string;
  src: string;
  startFrame: number;
  durationInFrames: number;
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

/** Resolve a clip src (/media/uploads/<name> or absolute path) to a local file. */
export function expandHomeDir(dir: string): string {
  return dir.replace(/^~(?=\/|$)/, process.env.HOME ?? '');
}

export function resolveMediaPath(src: string): string | undefined {
  const clean = String(src || '').trim();
  if (!clean) return undefined;
  if (clean.startsWith('/media/uploads/')) {
    const name = clean.slice('/media/uploads/'.length);
    if (!name || name.includes('/') || name.includes('\\')) return undefined;
    const roots = [...new Set([...uploadReadDirs(), WORKTREE_UPLOAD_DIR])];
    for (const dir of roots) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
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

function framesToSeconds(frames: number, fps: number): number {
  if (!Number.isFinite(frames) || frames < 0) return 0;
  return Math.round((frames / (fps || 30)) * 100) / 100;
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

/**
 * Build a CapCut/JianYing draft from an OpenChatCut timeline using capcut-cli.
 * The first video clip seeds the draft (quickstart); remaining video clips are
 * appended at their timeline positions; audio clips and captions follow.
 */
export async function exportJianyingDraft(raw: Partial<JianyingExportRequest>): Promise<JianyingExportResult> {
  const request: JianyingExportRequest = {
    fps: Number(raw.fps) || 30,
    items: Array.isArray(raw.items) ? raw.items.filter((item) => item && typeof item === 'object') : [],
    captions: Array.isArray(raw.captions) ? raw.captions.filter((caption) => caption && typeof caption === 'object') : [],
    draftName: typeof raw.draftName === 'string' ? raw.draftName : undefined,
    draftsDir: typeof raw.draftsDir === 'string' ? raw.draftsDir : undefined,
  };
  const warnings: string[] = [];
  const fps = Number(request.fps) || 30;
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
  const first = resolved[0];
  const firstStart = framesToSeconds(first.clip.startFrame, fps);
  const firstDuration = framesToSeconds(first.clip.durationInFrames, fps);
  const createArgs = [
    'quickstart', draftName,
    '--video', first.file as string,
    '--jianying', '--force-write', '--drafts', draftsDir,
  ];
  if (firstStart > 0) createArgs.push('--start', String(firstStart));
  if (firstDuration > 0) createArgs.push('--duration', String(firstDuration));
  const created = await runCapcut(createArgs) as { ok?: boolean; draft_path?: string; error?: string };
  if (!created?.ok || !created.draft_path) {
    return { ok: false, draftName, draftPath: '', addedVideos: 0, addedAudios: 0, captions: 0, warnings, error: created?.error || 'capcut-cli quickstart failed' };
  }
  const draftPath = created.draft_path;
  let addedVideos = 1;
  for (const entry of resolved.slice(1)) {
    const start = framesToSeconds(entry.clip.startFrame, fps);
    const duration = framesToSeconds(entry.clip.durationInFrames, fps);
    const args = ['add-video', draftPath, entry.file as string, String(start)];
    if (duration > 0) args.push(String(duration));
    args.push('--jianying', '--force-write', '--drafts', draftsDir);
    const result = await runCapcut(args) as { ok?: boolean; error?: string };
    if (result?.ok) addedVideos += 1;
    else warnings.push(`add-video ${basename(entry.file as string)}: ${result?.error || 'failed'}`);
  }
  let addedAudios = 0;
  for (const clip of audios) {
    const file = resolveMediaPath(clip.src);
    if (!file) {
      warnings.push(`audio not found locally: ${clip.src}`);
      continue;
    }
    const start = framesToSeconds(clip.startFrame, fps);
    const duration = framesToSeconds(clip.durationInFrames, fps);
    const args = ['add-audio', draftPath, file, String(start)];
    if (duration > 0) args.push(String(duration));
    args.push('--jianying', '--force-write', '--drafts', draftsDir);
    const result = await runCapcut(args) as { ok?: boolean; error?: string };
    if (result?.ok) addedAudios += 1;
    else warnings.push(`add-audio ${basename(file)}: ${result?.error || 'failed'}`);
  }
  let captions = 0;
  const captionList = (request.captions ?? []).filter((caption) => caption.text.trim() && caption.endMs > caption.startMs);
  if (captionList.length > 0) {
    const { file, dir } = await writeSrtFile(captionList);
    try {
      const result = await runCapcut(['import-srt', draftPath, file, '--jianying', '--force-write', '--drafts', draftsDir]) as { ok?: boolean; error?: string };
      if (result?.ok) captions = captionList.length;
      else warnings.push(`import-srt: ${result?.error || 'failed'}`);
    } finally {
      void rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return { ok: true, draftName, draftPath, addedVideos, addedAudios, captions, warnings };
}
