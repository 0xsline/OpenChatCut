// 时间线片段预览数据(轨道上的音波 + 视频缩略帧条):
//   GET /api/waveform?src=/media/uploads/x.mp4   → { peaks:number[], peaksPerSecond, durationMs }
//   GET /api/filmstrip?src=/media/uploads/x.mp4  → image/jpeg(1×N 帧横条)
// 服务端使用 ffmpeg 生成并缓存结果。峰值密度为 100/s；帧条对完整媒体时长
// 等距采样，客户端根据 trim、缩放和播放速率完成时间映射。
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSafeUploadName, resolveUploadFile, uploadDir } from '../media-dir.ts';
import { ffmpegBin } from '../frame-grid.ts';

const PEAKS_PER_SECOND = 100; // 源 samplesPerPeak = sampleRate/100
const MAX_PEAK_BINS = 12_000; // 超长素材降密度(远超任何屏幕像素宽,观感无损)
const PCM_RATE = 8000; // 峰值包络够用,解码快
const STRIP_HEIGHT = 44;
const MIN_STRIP_FRAMES = 8;
const MAX_STRIP_FRAMES = 32;
const SECONDS_PER_STRIP_FRAME = 8;
const FFMPEG_TIMEOUT_MS = 5 * 60_000;
const FRAME_CONCURRENCY = 4;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

/** /media/uploads/<name> → 安全文件名(其余一律拒绝) */
function uploadNameFromSrc(src: string): string | null {
  const clean = decodeURIComponent((src.split('?')[0] ?? '').trim());
  const m = clean.match(/^\/media\/uploads\/([^/]+)$/);
  if (!m) return null;
  return isSafeUploadName(m[1]) ? m[1] : null;
}

function previewDir(): string {
  return join(uploadDir(), '.preview');
}

/** 缓存名带上文件大小:同名文件被替换(normalize/重传)时自然失效。 */
function cacheKey(name: string, size: number, kind: string, ext: string): string {
  return join(previewDir(), `${name.replace(/[^a-zA-Z0-9_.-]/g, '_')}.${size}.${kind}.${ext}`);
}

function run(cmd: string, args: string[], timeoutMs = FFMPEG_TIMEOUT_MS): Promise<void> {
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
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exit ${code}: ${stderr.slice(-400)}`));
    });
  });
}

interface Probe { durationMs: number; width: number; height: number; hasAudio: boolean }

async function probe(file: string): Promise<Probe> {
  const json = await new Promise<string>((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v', 'error', '-print_format', 'json',
      '-show_entries', 'format=duration:stream=codec_type,width,height',
      file,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('ffprobe timed out')); }, 30_000);
    child.stdout?.on('data', (c: Buffer) => { out += String(c); });
    child.stderr?.on('data', (c: Buffer) => { err += String(c); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`ffprobe exit ${code}: ${err.slice(-300)}`));
    });
  });
  const parsed = JSON.parse(json) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };
  const video = parsed.streams?.find((s) => s.codec_type === 'video');
  return {
    durationMs: Math.max(0, Math.round(Number(parsed.format?.duration ?? 0) * 1000)),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    hasAudio: !!parsed.streams?.some((s) => s.codec_type === 'audio'),
  };
}

/** 解一路 8k 单声道 PCM,按 bin 取绝对值峰值(0..1 包络)。流式处理,不留整段缓冲。 */
function computePeaks(file: string, durationMs: number): Promise<number[]> {
  const seconds = Math.max(0.001, durationMs / 1000);
  const bins = Math.max(1, Math.min(MAX_PEAK_BINS, Math.round(seconds * PEAKS_PER_SECOND)));
  const samplesPerBin = Math.max(1, Math.floor((PCM_RATE * seconds) / bins));
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-i', file, '-vn', '-ac', '1', '-ar', String(PCM_RATE), '-f', 's16le', '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const peaks: number[] = [];
    let binMax = 0;
    let inBin = 0;
    let carry: Buffer | null = null; // 奇数字节跨 chunk 的半个样本
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('ffmpeg peaks timed out')); }, FFMPEG_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      let buf = chunk;
      if (carry) { buf = Buffer.concat([carry, chunk]); carry = null; }
      const usable = buf.length - (buf.length % 2);
      if (usable < buf.length) carry = buf.subarray(usable);
      for (let i = 0; i < usable; i += 2) {
        const v = Math.abs(buf.readInt16LE(i)) / 32768;
        if (v > binMax) binMax = v;
        if (++inBin >= samplesPerBin) {
          peaks.push(Math.round(binMax * 1000) / 1000);
          binMax = 0;
          inBin = 0;
        }
      }
    });
    child.stderr?.on('data', (c: Buffer) => { stderr += String(c); if (stderr.length > 4000) stderr = stderr.slice(-2000); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`ffmpeg peaks exit ${code}: ${stderr.slice(-300)}`)); return; }
      if (inBin > 0) peaks.push(Math.round(binMax * 1000) / 1000);
      resolve(peaks);
    });
  });
}

/** 等距抽 N 帧(-ss 前置快速定位)→ tile 成 1×N 横条。 */
async function buildFilmstrip(file: string, p: Probe, out: string): Promise<void> {
  const seconds = Math.max(0.001, p.durationMs / 1000);
  const n = Math.max(MIN_STRIP_FRAMES, Math.min(MAX_STRIP_FRAMES, Math.round(seconds / SECONDS_PER_STRIP_FRAME)));
  const aspect = p.width > 0 && p.height > 0 ? p.width / p.height : 16 / 9;
  const cellW = Math.max(24, Math.min(160, Math.round(STRIP_HEIGHT * aspect))) & ~1;
  const work = await mkdtemp(join(tmpdir(), 'cc-strip-'));
  try {
    const times = Array.from({ length: n }, (_, i) => ((i + 0.5) / n) * seconds);
    const cells = times.map((t, i) => ({ t, path: join(work, `f-${String(i).padStart(3, '0')}.jpg`) }));
    for (let i = 0; i < cells.length; i += FRAME_CONCURRENCY) {
      await Promise.all(cells.slice(i, i + FRAME_CONCURRENCY).map((c) => run(ffmpegBin(), [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', String(c.t), '-i', file, '-frames:v', '1',
        // 居中裁切填满格子:竖屏/异形素材也不会被拉扁
        '-vf', `scale=${cellW}:${STRIP_HEIGHT}:force_original_aspect_ratio=increase,crop=${cellW}:${STRIP_HEIGHT}`,
        '-q:v', '5', c.path,
      ])));
    }
    const present = cells.filter((c) => existsSync(c.path));
    if (!present.length) throw new Error('no frames extracted');
    await run(ffmpegBin(), [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', join(work, 'f-%03d.jpg'), '-vf', `tile=${present.length}x1`,
      '-frames:v', '1', '-q:v', '6', out,
    ]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** 同一素材的并发请求合流,避免同时跑多份 ffmpeg。 */
const inFlight = new Map<string, Promise<void>>();
function once(key: string, work: () => Promise<void>): Promise<void> {
  const running = inFlight.get(key);
  if (running) return running;
  const p = work().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

export function mediaPreviewPlugin(): Plugin {
  return {
    name: 'openchatcut-media-preview',
    configureServer(server) {
      const resolveReq = async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const name = uploadNameFromSrc(url.searchParams.get('src') ?? '');
        if (!name) { sendJson(res, 400, { error: 'src must be /media/uploads/<name>' }); return null; }
        const file = resolveUploadFile(name);
        if (!file || !existsSync(file)) { sendJson(res, 404, { error: 'media not found' }); return null; }
        const size = (await stat(file)).size;
        return { name, file, size };
      };

      server.middlewares.use('/api/waveform', async (req, res) => {
        try {
          const hit = await resolveReq(req, res);
          if (!hit) return;
          const cache = cacheKey(hit.name, hit.size, 'peaks', 'json');
          if (!existsSync(cache)) {
            await once(cache, async () => {
              const p = await probe(hit.file);
              if (!p.hasAudio) {
                await mkdir(previewDir(), { recursive: true });
                await writeFile(cache, JSON.stringify({ peaks: [], peaksPerSecond: PEAKS_PER_SECOND, durationMs: p.durationMs }));
                return;
              }
              const peaks = await computePeaks(hit.file, p.durationMs);
              await mkdir(previewDir(), { recursive: true });
              const tmp = `${cache}.tmp`;
              await writeFile(tmp, JSON.stringify({ peaks, peaksPerSecond: PEAKS_PER_SECOND, durationMs: p.durationMs }));
              await rename(tmp, cache); // 原子替换:半截 JSON 不会被读到
            });
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          res.end(await readFile(cache));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          server.config.logger.error(`[waveform] ${message}`);
          sendJson(res, /spawn|ENOENT/i.test(message) ? 503 : 500, { error: message });
        }
      });

      server.middlewares.use('/api/filmstrip', async (req, res) => {
        try {
          const hit = await resolveReq(req, res);
          if (!hit) return;
          const cache = cacheKey(hit.name, hit.size, 'strip', 'jpg');
          if (!existsSync(cache)) {
            await once(cache, async () => {
              const p = await probe(hit.file);
              if (!p.width || !p.height) throw new Error('not a video');
              await mkdir(previewDir(), { recursive: true });
              const tmp = `${cache}.tmp.jpg`;
              await buildFilmstrip(hit.file, p, tmp);
              await rename(tmp, cache);
            });
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', 'image/jpeg');
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          res.end(await readFile(cache));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          server.config.logger.error(`[filmstrip] ${message}`);
          sendJson(res, /spawn|ENOENT/i.test(message) ? 503 : 500, { error: message });
        }
      });
    },
  };
}
