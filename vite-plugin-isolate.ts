import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, access, writeFile, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join, extname, basename, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

// AI Voice Isolation pipeline (source isolate_voice / DeepFilterNet3).
// POST /api/isolate { path, strength? 0-100 }
// → extract mono 48kHz WAV → deep-filter if available → else speech-oriented
//   ffmpeg fallback (highpass + afftdn) so the UI pipeline is fully wired.
// Output lands under public/media/uploads/isolated-*.wav.

const PUBLIC = join(process.cwd(), 'public');
const OUT_DIR = join(PUBLIC, 'media', 'uploads');

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveP, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolveP(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function run(cmd: string, args: string[], cwd?: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolveP) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => resolveP({ code: 127, stderr: String(err) }));
    child.on('close', (code) => resolveP({ code: code ?? 1, stderr }));
  });
}

async function which(bin: string): Promise<string | null> {
  const r = await run(process.platform === 'win32' ? 'where' : 'which', [bin]);
  if (r.code !== 0) return null;
  // which writes to stdout — re-run with spawn capture
  return new Promise((resolveP) => {
    const child = spawn(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('close', (code) => resolveP(code === 0 ? out.trim().split('\n')[0] || null : null));
    child.on('error', () => resolveP(null));
  });
}

function resolvePublicPath(urlPath: string): string {
  // "/media/foo.mp3" → public/media/foo.mp3
  const clean = urlPath.replace(/^\/+/, '').replace(/\.\./g, '');
  return resolve(PUBLIC, clean);
}

async function extractWav(srcPath: string, wavPath: string): Promise<void> {
  const r = await run('ffmpeg', [
    '-y', '-i', srcPath,
    '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le',
    wavPath,
  ]);
  if (r.code !== 0) throw new Error(`ffmpeg extract failed: ${r.stderr.slice(-400)}`);
}

async function tryDeepFilter(wavIn: string, wavOut: string, strength: number): Promise<boolean> {
  const atten = Math.max(0, Math.min(100, Math.round(strength)));
  // Official CLI: deep-filter -a <0-100> <input.wav>
  const bin = (await which('deep-filter')) ?? (await which('deep-filter-py'));
  if (!bin) return false;
  const outDir = dirname(wavOut);
  const r = await run(bin, ['-a', String(atten), '-o', outDir, wavIn]);
  if (r.code !== 0) {
    // alternate python signature
    const r2 = await run(bin, [
      '--model-base-dir', 'DeepFilterNet3',
      '--atten-lim', String(atten),
      '--output-dir', outDir,
      wavIn,
    ]);
    if (r2.code !== 0) return false;
  }
  // deep-filter typically writes <name>_DeepFilterNet3.wav next to input or in -o
  const base = basename(wavIn, extname(wavIn));
  const candidates = [
    join(outDir, `${base}_DeepFilterNet3.wav`),
    join(outDir, `${base}.wav`),
    join(dirname(wavIn), `${base}_DeepFilterNet3.wav`),
  ];
  for (const c of candidates) {
    try {
      await access(c, fsConstants.R_OK);
      if (c !== wavOut) {
        const buf = await readFile(c);
        await writeFile(wavOut, buf);
      }
      return true;
    } catch { /* try next */ }
  }
  return false;
}

/** Speech-oriented fallback when DeepFilterNet3 binary is not installed. */
async function ffmpegSpeechFallback(wavIn: string, wavOut: string, strength: number): Promise<void> {
  // Map strength 0–100 → noise reduction amount (afftdn nr 0.01–0.5)
  const nr = (0.05 + (Math.max(0, Math.min(100, strength)) / 100) * 0.4).toFixed(3);
  // highpass speech band + FFT denoise + light compress
  const af = `highpass=f=80,lowpass=f=8000,afftdn=nr=${nr}:nf=-25,acompressor=threshold=-18dB:ratio=2:attack=5:release=50`;
  const r = await run('ffmpeg', ['-y', '-i', wavIn, '-af', af, wavOut]);
  if (r.code !== 0) throw new Error(`ffmpeg isolate fallback failed: ${r.stderr.slice(-400)}`);
}

export function isolatePlugin(): Plugin {
  return {
    name: 'chatcut-isolate',
    configureServer(server) {
      server.middlewares.use('/api/isolate', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'POST only' });
          return;
        }
        try {
          const body = await readJson(req);
          const path = typeof body.path === 'string' ? body.path.trim() : '';
          const strength = typeof body.strength === 'number' ? body.strength : 100;
          if (!path) {
            sendJson(res, 400, { error: 'path required (same-origin media URL)' });
            return;
          }
          const srcPath = resolvePublicPath(path);
          try {
            await access(srcPath, fsConstants.R_OK);
          } catch {
            sendJson(res, 404, { error: `source not found: ${path}` });
            return;
          }

          await mkdir(OUT_DIR, { recursive: true });
          const work = join(tmpdir(), `cc-isolate-${randomUUID()}`);
          await mkdir(work, { recursive: true });
          const wavIn = join(work, 'in.wav');
          const wavOut = join(work, 'out.wav');
          await extractWav(srcPath, wavIn);

          let engine: 'deepfilternet3' | 'ffmpeg-speech-fallback' = 'ffmpeg-speech-fallback';
          const okDf = await tryDeepFilter(wavIn, wavOut, strength);
          if (okDf) {
            engine = 'deepfilternet3';
          } else {
            await ffmpegSpeechFallback(wavIn, wavOut, strength);
          }

          const fname = `isolated-${randomUUID()}.wav`;
          const dest = join(OUT_DIR, fname);
          const buf = await readFile(wavOut);
          await writeFile(dest, buf);

          sendJson(res, 200, {
            path: `/media/uploads/${fname}`,
            bytes: buf.length,
            strength,
            engine,
            note: engine === 'deepfilternet3'
              ? 'DeepFilterNet3 applied'
              : 'deep-filter binary not found; used speech-oriented ffmpeg fallback (install deep-filter for source parity)',
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          server.config.logger.error(`[isolate] ${message}`);
          if (!res.headersSent) sendJson(res, 500, { error: message });
        }
      });
    },
  };
}
