import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getKey } from '../keystore.ts';
import { resolveUploadFile, uploadDir, isSafeUploadName } from '../media-dir.ts';
import type { TranscriptResult, TranscriptWord } from '../../src/transcript/types.ts';

const MAX_JSON = 32 * 1024;
const INSTALL_TIMEOUT_MS = 60 * 60_000;
const TRANSCRIBE_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_MODEL = 'small';
const DEFAULT_COMPUTE_TYPE = 'int8';
const MODELS = new Set(['tiny', 'base', 'small', 'medium', 'large-v3-turbo', 'large-v3', 'turbo', 'distil-large-v3']);
const COMPUTE_TYPES = new Set(['int8', 'int8_float16', 'float16', 'float32']);

export interface FasterWhisperStatus {
  installed: boolean;
  installing: boolean;
  model: string;
  computeType: string;
  runtimeDir: string;
  message: string;
}

interface InstallJob {
  id: string;
  status: 'running' | 'succeeded' | 'failed';
  model: string;
  computeType: string;
  message: string;
  log: string[];
  startedAt: number;
  finishedAt?: number;
}

export interface FasterWhisperRunnerDeps {
  spawn?: typeof spawn;
  spawnSync?: typeof spawnSync;
  now?: () => number;
}

const jobs = new Map<string, InstallJob>();

export function fasterWhisperRuntimeRoot(): string {
  const override = process.env.OPENCHATCUT_RUNTIME_DIR?.trim();
  const base = override || join(process.cwd(), '.openchatcut');
  return resolve(base, 'faster-whisper');
}

function normalizeModel(raw: unknown): string {
  const model = String(raw ?? (getKey('FASTER_WHISPER_MODEL') || DEFAULT_MODEL)).trim();
  return MODELS.has(model) ? model : DEFAULT_MODEL;
}

function normalizeComputeType(raw: unknown): string {
  const computeType = String(raw ?? (getKey('FASTER_WHISPER_COMPUTE_TYPE') || DEFAULT_COMPUTE_TYPE)).trim();
  return COMPUTE_TYPES.has(computeType) ? computeType : DEFAULT_COMPUTE_TYPE;
}

function venvDir(root = fasterWhisperRuntimeRoot()): string {
  return join(root, 'venv');
}

function binName(name: string): string {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

function venvPython(root = fasterWhisperRuntimeRoot()): string {
  return process.platform === 'win32'
    ? join(venvDir(root), 'Scripts', binName('python'))
    : join(venvDir(root), 'bin', 'python');
}

function modelMarker(root: string, model: string): string {
  return join(root, 'models', `${model}.ready.json`);
}

function latestRunningJob(): InstallJob | undefined {
  return [...jobs.values()].reverse().find((job) => job.status === 'running');
}

export function fasterWhisperStatusSync(model = normalizeModel(undefined)): FasterWhisperStatus {
  const root = fasterWhisperRuntimeRoot();
  const installing = Boolean(latestRunningJob());
  const installed = existsSync(venvPython(root)) && existsSync(modelMarker(root, model));
  return {
    installed,
    installing,
    model,
    computeType: normalizeComputeType(undefined),
    runtimeDir: root,
    message: installed
      ? `faster-whisper 已安装 · 模型 ${model}`
      : installing
        ? 'faster-whisper 正在安装'
        : 'faster-whisper 尚未安装',
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, max = MAX_JSON): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > max) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object');
  return parsed as Record<string, unknown>;
}

function pythonCandidates(): string[] {
  const configured = process.env.OPENCHATCUT_PYTHON?.trim();
  const candidates = [
    configured,
    'python3',
    process.platform === 'win32' ? 'py' : '',
    process.platform === 'win32' ? 'python' : '',
  ].filter(Boolean) as string[];
  return [...new Set(candidates)];
}

export function findPython(deps: FasterWhisperRunnerDeps = {}): string | null {
  const run = deps.spawnSync ?? spawnSync;
  for (const candidate of pythonCandidates()) {
    const args = candidate === 'py' ? ['-3', '--version'] : ['--version'];
    const result = run(candidate, args, { encoding: 'utf8' });
    if (result.status === 0) return candidate;
  }
  return null;
}

function spawnLogged(
  command: string,
  args: string[],
  options: SpawnOptions,
  job: InstallJob,
  deps: FasterWhisperRunnerDeps,
  timeoutMs = INSTALL_TIMEOUT_MS,
): Promise<void> {
  const run = deps.spawn ?? spawn;
  return new Promise((resolvePromise, reject) => {
    const child = run(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    const push = (chunk: Buffer | string): void => {
      const text = String(chunk).trim();
      if (!text) return;
      job.log.push(text.slice(-1000));
      if (job.log.length > 80) job.log.splice(0, job.log.length - 80);
      job.message = text.split('\n').pop() ?? text;
    };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolvePromise() : reject(new Error(`${command} exit ${code}: ${job.message}`));
    });
  });
}

async function ensureRunner(root: string): Promise<string> {
  const scriptDir = join(root, 'runner');
  await mkdir(scriptDir, { recursive: true });
  const script = join(scriptDir, 'transcribe.py');
  await writeFile(script, RUNNER_PY, 'utf8');
  return script;
}

async function installFasterWhisper(job: InstallJob, deps: FasterWhisperRunnerDeps = {}): Promise<void> {
  const root = fasterWhisperRuntimeRoot();
  await mkdir(join(root, 'models'), { recursive: true });
  const py = findPython(deps);
  if (!py) throw new Error('未找到 Python 3 · 可设置 OPENCHATCUT_PYTHON 指向 python 可执行文件');
  job.message = '正在创建 Python venv…';
  const venvArgs = py === 'py' ? ['-3', '-m', 'venv', venvDir(root)] : ['-m', 'venv', venvDir(root)];
  if (!existsSync(venvPython(root))) {
    await spawnLogged(py, venvArgs, { cwd: root }, job, deps);
  }
  const vpy = venvPython(root);
  job.message = '正在安装 faster-whisper…';
  await spawnLogged(vpy, ['-m', 'pip', 'install', '--upgrade', 'pip'], { cwd: root }, job, deps);
  await spawnLogged(vpy, ['-m', 'pip', 'install', '--upgrade', 'faster-whisper'], { cwd: root }, job, deps);
  const runner = await ensureRunner(root);
  job.message = `正在下载并准备模型 ${job.model}…`;
  await spawnLogged(vpy, [runner, '--prepare', '--model', job.model, '--compute_type', job.computeType], {
    cwd: root,
    env: fasterWhisperEnv(root),
  }, job, deps);
  await mkdir(join(root, 'models'), { recursive: true });
  await writeFile(modelMarker(root, job.model), JSON.stringify({ model: job.model, computeType: job.computeType, installedAt: new Date().toISOString() }), 'utf8');
}

export function startFasterWhisperInstall(
  input: { model?: unknown; computeType?: unknown } = {},
  deps: FasterWhisperRunnerDeps = {},
): InstallJob {
  const model = normalizeModel(input.model);
  const computeType = normalizeComputeType(input.computeType);
  const running = latestRunningJob();
  if (running) return running;
  const job: InstallJob = {
    id: `fw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'running',
    model,
    computeType,
    message: '准备安装 faster-whisper…',
    log: [],
    startedAt: deps.now?.() ?? Date.now(),
  };
  jobs.set(job.id, job);
  void installFasterWhisper(job, deps)
    .then(() => {
      job.status = 'succeeded';
      job.message = `faster-whisper 已安装 · 模型 ${model}`;
    })
    .catch((error: unknown) => {
      job.status = 'failed';
      job.message = error instanceof Error ? error.message : String(error);
    })
    .finally(() => { job.finishedAt = deps.now?.() ?? Date.now(); });
  return job;
}

export function getFasterWhisperInstallJob(id: string): InstallJob | undefined {
  return jobs.get(id);
}

function fasterWhisperEnv(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HF_HOME: process.env.HF_HOME || join(root, 'huggingface'),
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || join(root, 'cache'),
  };
  if (process.env.CT2_FORCE_CPU_ISA?.trim()) {
    env.CT2_FORCE_CPU_ISA = process.env.CT2_FORCE_CPU_ISA.trim();
  } else {
    delete env.CT2_FORCE_CPU_ISA;
  }
  return env;
}

function uploadNameFromSrc(src: string): string | null {
  const clean = decodeURIComponent((src.split('?')[0] ?? '').trim());
  const m = clean.match(/^\/media\/uploads\/([^/]+)$/);
  if (!m) return null;
  return isSafeUploadName(m[1]) ? m[1] : null;
}

function resolveTranscribeInput(src: string): string | null {
  const name = uploadNameFromSrc(src);
  return name ? resolveUploadFile(name) : null;
}

function normalizeWord(row: { text?: unknown; start?: unknown; end?: unknown }): TranscriptWord | null {
  const text = String(row.text ?? '').trim();
  const start = Number(row.start);
  const end = Number(row.end);
  if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { text, start, end, speaker: null };
}

export async function runFasterWhisperTranscription(input: {
  src: string;
  model?: unknown;
  computeType?: unknown;
  languageCode?: unknown;
}, deps: FasterWhisperRunnerDeps = {}): Promise<TranscriptResult> {
  const root = fasterWhisperRuntimeRoot();
  const model = normalizeModel(input.model);
  if (!fasterWhisperStatusSync(model).installed) {
    throw Object.assign(new Error(`faster-whisper 未安装 · 请先在设置中安装模型 ${model}`), { statusCode: 409 });
  }
  const file = resolveTranscribeInput(input.src);
  if (!file) throw Object.assign(new Error('media source is unavailable to local ASR'), { statusCode: 404 });
  await stat(file);
  const runner = await ensureRunner(root);
  const out = await runJsonProcess(
    venvPython(root),
    [
      runner,
      '--input', file,
      '--model', model,
      '--compute_type', normalizeComputeType(input.computeType),
      '--language', String(input.languageCode || 'zh'),
    ],
    { cwd: root, env: fasterWhisperEnv(root) },
    deps,
  );
  const parsed = JSON.parse(out) as { text?: unknown; words?: Array<{ text?: unknown; start?: unknown; end?: unknown }> };
  const words = Array.isArray(parsed.words) ? parsed.words.map(normalizeWord).filter((w): w is TranscriptWord => Boolean(w)) : [];
  const text = typeof parsed.text === 'string' ? parsed.text : words.map((word) => word.text).join('');
  return { text, words, utterances: [] };
}

function runJsonProcess(
  command: string,
  args: string[],
  options: SpawnOptions,
  deps: FasterWhisperRunnerDeps,
): Promise<string> {
  const run = deps.spawn ?? spawn;
  return new Promise((resolvePromise, reject) => {
    const child = run(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`faster-whisper timed out after ${Math.round(TRANSCRIBE_TIMEOUT_MS / 1000)}s`));
    }, TRANSCRIBE_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolvePromise(stdout) : reject(new Error(`faster-whisper exit ${code}: ${stderr.slice(-700)}`));
    });
  });
}

export function fasterWhisperProbe(model?: string): Response {
  const status = fasterWhisperStatusSync(normalizeModel(model));
  return new Response(JSON.stringify(status), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function fasterWhisperPostCheck(bodyText: string): string | null {
  try {
    const status = JSON.parse(bodyText) as FasterWhisperStatus;
    return status.installed ? null : status.message;
  } catch {
    return '无法读取 faster-whisper 状态';
  }
}

export function fasterWhisperOkText(bodyText: string): string | null {
  try {
    return (JSON.parse(bodyText) as FasterWhisperStatus).message ?? null;
  } catch {
    return null;
  }
}

async function handleStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  sendJson(res, 200, fasterWhisperStatusSync(normalizeModel(url.searchParams.get('model'))));
}

async function handleInstall(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const job = startFasterWhisperInstall({ model: body.model, computeType: body.computeType });
  sendJson(res, 200, job);
}

async function handleTranscribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const src = String(body.src ?? '').trim();
  if (!src) {
    sendJson(res, 400, { error: 'src is required' });
    return;
  }
  const result = await runFasterWhisperTranscription({
    src,
    model: body.model,
    computeType: body.computeType,
    languageCode: body.languageCode,
  });
  sendJson(res, 200, result);
}

export function fasterWhisperPlugin(): Plugin {
  return {
    name: 'openchatcut-faster-whisper',
    configureServer(server) {
      mkdirSync(uploadDir(), { recursive: true });
      server.middlewares.use('/api/asr/faster-whisper/status', async (req, res) => {
        try {
          if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed — use GET' }); return; }
          await handleStatus(req, res);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[faster-whisper] ${message}`);
          if (!res.headersSent) sendJson(res, 500, { error: message });
        }
      });
      server.middlewares.use('/api/asr/faster-whisper/install', async (req, res) => {
        try {
          if (req.method === 'GET') {
            const id = decodeURIComponent((req.url ?? '').replace(/^\//, '').trim());
            const job = id ? getFasterWhisperInstallJob(id) : latestRunningJob();
            sendJson(res, job ? 200 : 404, job ?? { error: 'install job not found' });
            return;
          }
          if (req.method === 'POST') { await handleInstall(req, res); return; }
          sendJson(res, 405, { error: 'method not allowed — use POST or GET' });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[faster-whisper] ${message}`);
          if (!res.headersSent) sendJson(res, 500, { error: message });
        }
      });
      server.middlewares.use('/api/asr/transcribe', async (req, res) => {
        try {
          if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed — use POST' }); return; }
          await handleTranscribe(req, res);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
            ? (error as { statusCode: number }).statusCode
            : /ENOENT|unavailable|not found/i.test(message) ? 404 : 500;
          server.config.logger.error(`[faster-whisper] ${message}`);
          if (!res.headersSent) sendJson(res, statusCode, { error: message });
        }
      });
    },
  };
}

const RUNNER_PY = String.raw`#!/usr/bin/env python3
import argparse
import json
import sys

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--model", default="small")
    parser.add_argument("--compute_type", default="int8")
    parser.add_argument("--language", default="zh")
    args = parser.parse_args()

    from faster_whisper import WhisperModel

    model = WhisperModel(args.model, device="cpu", compute_type=args.compute_type)
    if args.prepare:
        print(json.dumps({"ok": True, "model": args.model}))
        return
    if not args.input:
        raise SystemExit("--input is required")

    language = None if args.language == "auto" else args.language
    segments, _info = model.transcribe(
        args.input,
        language=language,
        word_timestamps=True,
        vad_filter=True,
    )
    words = []
    texts = []
    for segment in segments:
        if segment.text:
            texts.append(segment.text.strip())
        for word in segment.words or []:
            text = (word.word or "").strip()
            if not text:
                continue
            words.append({
                "text": text,
                "start": int(round(float(word.start) * 1000)),
                "end": int(round(float(word.end) * 1000)),
            })
    print(json.dumps({"text": "".join(texts), "words": words}, ensure_ascii=False))

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise
`;
