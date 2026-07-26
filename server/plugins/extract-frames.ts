// POST /api/extract-frames — ffmpeg contact sheet for a local /media/uploads video.
// view_asset_frames fast path: sample sourceTimesMs (or evenly spaced midpoints),
// stamp labels, and tile them into one JPEG without invoking Remotion.
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSafeUploadName, resolveUploadFile } from '../media-dir.ts';
import { formatTimeLabel, tileContactSheet } from '../frame-grid.ts';
import { ffmpegBin } from '../media-binaries.ts';

const MAX_JSON = 32 * 1024;
const MAX_SAMPLES = 20;
const DEFAULT_SAMPLES = 12;
const FFMPEG_TIMEOUT_MS = 10 * 60_000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage, max = MAX_JSON): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function uploadNameFromSrc(src: string): string | null {
  const clean = decodeURIComponent((src.split('?')[0] ?? '').trim());
  const m = clean.match(/^\/media\/uploads\/([^/]+)$/);
  if (!m) return null;
  return isSafeUploadName(m[1]) ? m[1] : null;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
    child.stderr?.on('data', (c: Buffer) => {
      stderr += String(c);
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exit ${code}: ${stderr.slice(-400)}`));
    });
  });
}

async function probeDurationMs(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      path,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (c: Buffer) => { out += String(c); });
    child.on('error', reject);
    child.on('close', (code) => {
      const sec = Number(out.trim());
      if (code === 0 && Number.isFinite(sec) && sec > 0) resolve(Math.round(sec * 1000));
      else reject(new Error('ffprobe duration failed'));
    });
  });
}

/** Midpoints of N equal blocks in [fromMs, toMs). */
export function sampleTimesMs(fromMs: number, toMs: number, count: number): number[] {
  const n = Math.max(1, Math.min(MAX_SAMPLES, Math.round(count)));
  const lo = Math.max(0, fromMs);
  const hi = Math.max(lo + 1, toMs);
  const span = hi - lo;
  return Array.from({ length: n }, (_, i) => Math.round(lo + ((i + 0.5) / n) * span));
}

// ── 近重复剔除 ────────────────────────────────────────────────────────────
// 均匀取样在固定机位素材上会得到 N 张几乎一样的图,白白烧掉视觉 token 也帮不上
// 定位。先用 ffmpeg 场景检测挑出「画面真的变了」的时刻,不够再用均匀取样补齐。
// 分析在缩到 160 宽、2fps 上做,成本有界;任何失败都静默退回均匀取样。

/** 场景差异阈值(0..1):够低才能抓到机位内的动作变化,不只是硬切。 */
const SCENE_THRESHOLD = 0.08;
const SCENE_ANALYSIS_TIMEOUT_MS = 20_000;

/** 画面显著变化的时刻(毫秒,升序)。失败返回空数组 = 调用方退回均匀取样。 */
function sceneChangeTimesMs(input: string, fromMs: number, toMs: number): Promise<number[]> {
  return new Promise((resolve) => {
    const times: number[] = [];
    const child = spawn(ffmpegBin(), [
      '-nostdin', '-hide_banner',
      '-ss', String(Math.max(0, fromMs) / 1000),
      '-t', String(Math.max(0, toMs - fromMs) / 1000),
      '-i', input,
      '-an', '-sn',
      '-vf', `scale=160:-2,fps=2,select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
      '-f', 'null', '-',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let tail = '';
    const done = (): void => { child.kill('SIGKILL'); resolve(times); };
    const timer = setTimeout(done, SCENE_ANALYSIS_TIMEOUT_MS);
    child.stderr?.on('data', (chunk: Buffer) => {
      // 流式解析 pts_time,避免把整段 showinfo 攒在内存里
      tail += String(chunk);
      const lines = tail.split('\n');
      tail = lines.pop() ?? '';
      for (const line of lines) {
        const m = /pts_time:([0-9.]+)/.exec(line);
        if (m) times.push(Math.round(fromMs + Number(m[1]) * 1000));
      }
    });
    child.on('error', () => { clearTimeout(timer); resolve([]); });
    child.on('close', () => { clearTimeout(timer); resolve(times); });
  });
}

/**
 * 变化时刻优先、均匀取样补齐,凑够 count 个采样点(升序、互不挨太近)。
 * 纯函数,便于测试。
 */
export function pickDistinctTimes(
  candidates: readonly number[],
  fromMs: number,
  toMs: number,
  count: number,
): number[] {
  const n = Math.max(1, Math.min(MAX_SAMPLES, Math.round(count)));
  const lo = Math.max(0, fromMs);
  const hi = Math.max(lo + 1, toMs);
  const minGap = (hi - lo) / (n * 2); // 挨得太近的算同一处,不重复占位
  const picked: number[] = [];
  const tryPush = (t: number): void => {
    if (picked.length >= n || t < lo || t >= hi) return;
    if (picked.some((p) => Math.abs(p - t) < minGap)) return;
    picked.push(t);
  };
  // 候选多于名额时按序均摊,避免只取到开头那一堆
  const sorted = [...candidates].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  const stride = sorted.length > n ? sorted.length / n : 1;
  for (let i = 0; i < sorted.length && picked.length < n; i += 1) {
    if (stride > 1 && Math.floor(i % stride) !== 0) continue;
    tryPush(sorted[i]!);
  }
  for (const t of sampleTimesMs(lo, hi, n)) tryPush(t);
  return picked.sort((a, b) => a - b);
}

async function extractOneFrame(input: string, timeMs: number, outPath: string): Promise<void> {
  const ss = Math.max(0, timeMs / 1000);
  // -ss before -i for fast seek; fine for contact-sheet accuracy
  await run('ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(ss),
    '-i', input,
    '-frames:v', '1',
    '-q:v', '4',
    outPath,
  ], FFMPEG_TIMEOUT_MS);
}

export function extractFramesPlugin(): Plugin {
  return {
    name: 'openchatcut-extract-frames',
    configureServer(server) {
      server.middlewares.use('/api/extract-frames', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed — use POST' });
          return;
        }
        const work = await mkdtemp(join(tmpdir(), 'cc-frames-'));
        try {
          const body = (await readJson(req)) as {
            src?: string;
            sourceTimesMs?: unknown;
            count?: number;
            fromMs?: number;
            toMs?: number;
            cols?: number;
          };
          const src = String(body.src ?? '').trim();
          const name = uploadNameFromSrc(src);
          if (!name) {
            sendJson(res, 400, { error: 'src must be /media/uploads/<safe-name>' });
            return;
          }
          const inputPath = resolveUploadFile(name);
          if (!inputPath || !existsSync(inputPath)) {
            sendJson(res, 404, { error: `media not found: ${name}` });
            return;
          }

          let times: number[];
          if (Array.isArray(body.sourceTimesMs) && body.sourceTimesMs.length) {
            times = body.sourceTimesMs
              .map((t) => Number(t))
              .filter((t) => Number.isFinite(t) && t >= 0)
              .slice(0, MAX_SAMPLES);
          } else {
            const durationMs = await probeDurationMs(inputPath);
            const fromMs = typeof body.fromMs === 'number' && body.fromMs >= 0 ? body.fromMs : 0;
            const toMs = typeof body.toMs === 'number' && body.toMs > fromMs
              ? Math.min(body.toMs, durationMs)
              : durationMs;
            const count = typeof body.count === 'number' ? body.count : DEFAULT_SAMPLES;
            // 变化处优先(固定机位不会再回 N 张同图);分析失败自动退回均匀取样
            const scenes = await sceneChangeTimesMs(inputPath, fromMs, toMs);
            times = scenes.length
              ? pickDistinctTimes(scenes, fromMs, toMs, count)
              : sampleTimesMs(fromMs, toMs, count);
          }
          if (!times.length) {
            sendJson(res, 400, { error: 'no sample times' });
            return;
          }

          const cells: { jpeg: Buffer; label: string }[] = [];
          for (let i = 0; i < times.length; i += 1) {
            const t = times[i]!;
            const framePath = join(work, `f-${i}.jpg`);
            try {
              await extractOneFrame(inputPath, t, framePath);
              cells.push({
                jpeg: await readFile(framePath),
                label: formatTimeLabel(t),
              });
            } catch (err) {
              server.config.logger.info(
                `[extract-frames] skip t=${t}ms: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          if (!cells.length) {
            sendJson(res, 422, { error: 'could not extract any frames (codec/corrupt?)' });
            return;
          }

          const cols = typeof body.cols === 'number' && body.cols > 0
            ? Math.min(8, Math.round(body.cols))
            : undefined;
          const sheet = await tileContactSheet(cells, {
            cellWidth: cells.length > 9 ? 280 : 320,
            cols,
          });

          sendJson(res, 200, {
            ok: true,
            base64: sheet.toString('base64'),
            mediaType: 'image/jpeg',
            sampleCount: cells.length,
            sourceTimesMs: times.slice(0, cells.length),
            labels: cells.map((c) => c.label),
            renderedBy: 'ffmpeg',
            note: `contact sheet · ${cells.length} samples from ${name}`,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          server.config.logger.error(`[extract-frames] ${message}`);
          const status = /ENOENT|spawn ffmpeg|spawn ffprobe/i.test(message) ? 503 : 500;
          sendJson(res, status, { error: message });
        } finally {
          await rm(work, { recursive: true, force: true }).catch(() => {});
        }
      });
    },
  };
}
