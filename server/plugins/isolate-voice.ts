// POST /api/isolate-voice — voice isolation backend for the isolate_voice tool.
// ffmpeg spectral denoise + speech band (afftdn / highpass / lowpass), no
// proprietary model. Writes a mono/stereo audio file next to the source and returns its
// /media/uploads path for setItemDenoise(denoisedSrc).
//
// Body: { src: '/media/uploads/…', strength?: 0..100 }
// strength maps to afftdn nr (noise reduction dB): 0 → light, 100 → aggressive.
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { constants, existsSync } from 'node:fs';
import { copyFile, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { isSafeUploadName, resolveUploadFile, uploadDir } from '../media-dir.ts';
import { ffmpegThreadArgs, spawnMediaProcess } from '../media-process.ts';

const MAX_JSON = 8 * 1024;
const FFMPEG_TIMEOUT_MS = 30 * 60_000;
export const VOICE_ISOLATION_ENGINE_VERSION = 'ffmpeg-afftdn-v2';

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

function denoiseStem(sourceName: string): string {
  const stem = sourceName.replace(/\.[^.]+$/, '') || sourceName;
  return stem.replace(/[^a-zA-Z0-9_\u4e00-\u9fff-]+/g, '_').slice(0, 72) || 'media';
}

const artifactSegment = (value: string): string => (
  value.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'unknown'
);

export function voiceIsolationArtifactName(
  sourceName: string,
  sourceRevision: string,
  strength: number,
  forceNonce?: string,
): string {
  const identity = [
    denoiseStem(sourceName),
    'voice',
    artifactSegment(sourceRevision),
    artifactSegment(VOICE_ISOLATION_ENGINE_VERSION),
    `s${Math.round(Math.max(0, Math.min(100, strength)))}`,
    forceNonce ? artifactSegment(forceNonce) : undefined,
  ].filter((part): part is string => part !== undefined);
  return `${identity.join('.')}.m4a`;
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnMediaProcess('ffmpeg', [...ffmpegThreadArgs(), ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s`));
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
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`));
    });
  });
}

/** Map UI strength 0..100 → afftdn nr (noise reduction amount). */
function nrFromStrength(strength: number): number {
  const s = Math.max(0, Math.min(100, strength));
  // 6 dB light → 24 dB heavy
  return 6 + (s / 100) * 18;
}

/**
 * Build an open-box speech isolation filter chain.
 * afftdn may be missing on some ffmpeg builds → fall back to band + mild denoise.
 */
function filterChains(strength: number): string[] {
  const nr = nrFromStrength(strength).toFixed(1);
  const nf = (-40 + (strength / 100) * 10).toFixed(1); // noise floor estimate
  return [
    // Primary: FFT denoise + speech band
    `highpass=f=80,lowpass=f=8000,afftdn=nr=${nr}:nf=${nf}:tn=1`,
    // Fallback without afftdn
    `highpass=f=100,lowpass=f=7000,anlmdn=s=0.0001:p=0.02:r=0.002:m=15`,
    // Last resort: band-limit only (still clarifies voice vs rumble)
    `highpass=f=120,lowpass=f=6500,acompressor=threshold=-20dB:ratio=3:attack=5:release=50`,
  ];
}

async function isolateToFile(
  inputPath: string,
  finalPath: string,
  strength: number,
): Promise<number> {
  const partPath = finalPath.replace(/(\.(m4a|mp3|ogg|wav))$/i, `.${randomUUID()}.tmp$1`);
  let lastErr: Error | null = null;
  for (const af of filterChains(strength)) {
    try {
      await runFfmpeg(
        [
          '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
          '-i', inputPath,
          '-vn',
          '-map', '0:a:0?',
          '-af', af,
          '-c:a', 'aac', '-b:a', '128k',
          partPath,
        ],
        FFMPEG_TIMEOUT_MS,
      );
      try {
        await copyFile(partPath, finalPath, constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      } finally {
        await unlink(partPath).catch(() => {});
      }
      return (await stat(finalPath)).size;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      await unlink(partPath).catch(() => {});
    }
  }
  throw lastErr ?? new Error('isolate-voice failed');
}

export function isolateVoicePlugin(): Plugin {
  return {
    name: 'openchatcut-isolate-voice',
    configureServer(server) {
      server.middlewares.use('/api/isolate-voice', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed — use POST' });
          return;
        }
        try {
          const body = (await readJson(req)) as {
            src?: string;
            strength?: number;
            force?: boolean;
            sourceRevision?: string;
          };
          const src = String(body.src ?? '').trim();
          const name = uploadNameFromSrc(src);
          if (!name) {
            sendJson(res, 400, { error: 'src must be /media/uploads/<safe-name>' });
            return;
          }
          const inputPath = resolveUploadFile(name);
          if (!inputPath) {
            sendJson(res, 404, { error: `media not found: ${name}` });
            return;
          }

          const strength = Number.isFinite(Number(body.strength))
            ? Math.max(0, Math.min(100, Number(body.strength)))
            : 70;
          const sourceInfo = await stat(inputPath);
          const sourceRevision = typeof body.sourceRevision === 'string' && body.sourceRevision.trim()
            ? body.sourceRevision.trim()
            : `legacy-${sourceInfo.size}-${Math.round(sourceInfo.mtimeMs)}`;
          const outName = voiceIsolationArtifactName(
            name,
            sourceRevision,
            strength,
            body.force ? randomUUID() : undefined,
          );
          const finalPath = join(uploadDir(), outName);

          if (!body.force && existsSync(finalPath)) {
            try {
              const info = await stat(finalPath);
              if (info.isFile() && info.size > 0) {
                sendJson(res, 200, {
                  ok: true,
                  path: `/media/uploads/${outName}`,
                  bytes: info.size,
                  cached: true,
                  strength,
                  engine: VOICE_ISOLATION_ENGINE_VERSION,
                  sourceRevision,
                  source: src,
                });
                return;
              }
            } catch { /* re-run */ }
          }

          const bytes = await isolateToFile(inputPath, finalPath, 100);
          if (bytes <= 0) {
            sendJson(res, 422, { error: 'isolated audio is empty (source may have no audio track)' });
            return;
          }
          server.config.logger.info(
            `[isolate-voice] ${name} → ${basename(finalPath)} (${bytes} bytes, strength=${strength})`,
          );
          sendJson(res, 200, {
            ok: true,
            path: `/media/uploads/${outName}`,
            bytes,
            cached: false,
            strength,
            engine: VOICE_ISOLATION_ENGINE_VERSION,
            sourceRevision,
            note: 'Immutable full-wet ffmpeg isolation artifact. Playback applies strength as a dry/wet mix; master src is unchanged.',
            source: src,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          server.config.logger.error(`[isolate-voice] ${message}`);
          const status = /ENOENT|spawn ffmpeg/i.test(message) ? 503
            : /no audio|empty|exit/i.test(message) ? 422
              : 500;
          sendJson(res, status, { error: message });
        }
      });
    },
  };
}
