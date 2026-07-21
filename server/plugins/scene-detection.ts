import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isSafeUploadName, resolveUploadFile } from '../media-dir.ts';
import { ffmpegBin, ffprobeBin } from '../media-binaries.ts';
import {
  DEFAULT_MAX_SCENES,
  DEFAULT_MIN_SCENE_MS,
  normalizeSceneCandidates,
  normalizeSceneThreshold,
  parseSceneMetadata,
  type SceneChange,
} from '../../src/scene-detection/detect.ts';

const MAX_JSON = 16 * 1024;
const DETECT_TIMEOUT_MS = 30 * 60_000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_JSON) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function uploadNameFromSrc(src: string): string | null {
  const clean = decodeURIComponent((src.split('?')[0] ?? '').trim());
  const match = clean.match(/^\/media\/uploads\/([^/]+)$/);
  if (!match) return null;
  return isSafeUploadName(match[1]) ? match[1] : null;
}

function runCapture(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
      if (stderr.length > 12_000) stderr = stderr.slice(-6000);
    });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exit ${code}: ${stderr.slice(-800)}`));
    });
  });
}

async function probeDurationMs(file: string): Promise<number> {
  const output = await runCapture(ffprobeBin(), [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
  ], 30_000);
  const seconds = Number(output.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('ffprobe duration failed');
  return Math.round(seconds * 1000);
}

export interface DetectScenesOptions {
  threshold?: number;
  minSceneMs?: number;
  maxScenes?: number;
}

export interface DetectScenesResult {
  durationMs: number;
  threshold: number;
  minSceneMs: number;
  scenes: SceneChange[];
}

/** Decode once at low resolution and let FFmpeg calculate inter-frame scene scores. */
export async function detectScenesInFile(
  file: string,
  options: DetectScenesOptions = {},
): Promise<DetectScenesResult> {
  const threshold = normalizeSceneThreshold(options.threshold);
  const minSceneMs = Math.max(100, Math.min(60_000, Math.round(options.minSceneMs ?? DEFAULT_MIN_SCENE_MS)));
  const maxScenes = Math.max(1, Math.min(500, Math.round(options.maxScenes ?? DEFAULT_MAX_SCENES)));
  const durationMs = await probeDurationMs(file);
  const filter = `scale=320:-2:flags=fast_bilinear,select='gt(scene,${threshold})',metadata=print:file=-`;
  const output = await runCapture(ffmpegBin(), [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', file,
    '-map', '0:v:0', '-vf', filter, '-an', '-f', 'null', '-',
  ], DETECT_TIMEOUT_MS);
  const scenes = normalizeSceneCandidates(parseSceneMetadata(output), {
    threshold, minSceneMs, durationMs, maxScenes,
  });
  return { durationMs, threshold, minSceneMs, scenes };
}

export function sceneDetectionPlugin(): Plugin {
  return {
    name: 'openchatcut-scene-detection',
    configureServer(server) {
      server.middlewares.use('/api/detect-scenes', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed — use POST' });
          return;
        }
        try {
          const body = (await readJson(req)) as {
            src?: string;
            threshold?: number;
            minSceneMs?: number;
            maxScenes?: number;
          };
          const name = uploadNameFromSrc(String(body.src ?? ''));
          if (!name) {
            sendJson(res, 400, { error: 'src must be /media/uploads/<safe-name>' });
            return;
          }
          const file = resolveUploadFile(name);
          if (!file || !existsSync(file)) {
            sendJson(res, 404, { error: `media not found: ${name}` });
            return;
          }
          const fileSize = (await stat(file)).size;
          const result = await detectScenesInFile(file, body);
          sendJson(res, 200, { ok: true, src: body.src, fileSize, ...result });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[scene-detection] ${message}`);
          const status = /ENOENT|spawn|ffmpeg|ffprobe/i.test(message) ? 503 : 500;
          sendJson(res, status, { error: message });
        }
      });
    },
  };
}
