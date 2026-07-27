// KikiVoice client — TypeScript port of OpenCut-AI's services/kiki_service.py.
// Cookie-auth + voice-cloning flow, run over an injectable KikiTransport (Electron net+session).
// f5-tts is DROPPED: the clone ref comes from a bundled/sample audio (getRefAudio), not a voice library.

import { KikiError } from './types.ts';
import type {
  KikiTransport,
  KikiQuotaSnapshot,
  KikiFilePart,
  KikiHeaders,
} from './types.ts';

const VOICE_CACHE_TTL_MS = 23 * 3600 * 1000; // KikiVoice presets live 24h; reuse under that.
const HUMAN_VERIFICATION_ERROR_CODE = 777; // GeeTest per-IP gate; cf_clearance/fpestid stale.
const MIN_REUSE_REMAINING_TTL_S = 2 * 3600; // skip a server-side voice about to expire.
const CREATE_MAX_RETRIES = 3;
const CREATE_BACKOFF_MS = [8000, 15000, 25000];

export interface KikiClientOptions {
  baseUrl: string; // https://kikivoice.ai
  model: string; // KIKI_MODEL (e.g. "kiki_core")
  userAgent: string; // must match the UA the login window used (cf_clearance binds IP+UA)
  /** TTS speed multiplier passed to create-task ('1' = normal). <1 slower, >1 faster.
   *  From KIKI_SPEED env. Use to compensate a clone whose natural pace misses the target WPS
   *  (e.g. joni speaks ~3.1 wps at '1'; '0.8' ≈ 2.5 wps). Prefer planning at the real WPS
   *  (VITE_NARRATION_WPS) over slowing the voice — slowed TTS can sound unnatural. */
  speed?: string;
  transport: KikiTransport;
  /** Clone reference audio for a voice id. Desktop bundles joni.wav (Indonesian). */
  getRefAudio: (voiceId: string) => Promise<KikiFilePart>;
  /** Fired when create-task returns 777 (GeeTest). Desktop drives the persist:partition BrowserWindow.
   *  Resolve true if the gate was cleared (caller retries create-task); false/throw → KikiError expired. */
  onRevalidateNeeded?: () => Promise<boolean>;
  /** Best-effort quota capture sink (piggybacked on create-task responses). */
  quotaSink?: (q: KikiQuotaSnapshot) => void;
}

interface SigInfo {
  sig: string;
  createVoiceUrl: string;
  voiceListUrl: string;
}

interface VoiceListEntry {
  voice_id?: string;
  voice_name?: string;
  create_time?: number;
  ttl?: number;
  custom_data?: string;
}

interface VoiceCacheEntry {
  voiceId: string;
  promptText: string;
  cachedAt: number;
}

function jsonOrThrow(text: string, status: number, context: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new KikiError(`${context}: non-JSON response (HTTP ${status}) ${text.slice(0, 200)}`);
  }
  if (!data || typeof data !== 'object') {
    throw new KikiError(`${context}: unexpected response (HTTP ${status}) ${text.slice(0, 200)}`);
  }
  return data as Record<string, unknown>;
}

function promptFromEntry(entry: VoiceListEntry): string {
  try {
    const custom = entry.custom_data ? (JSON.parse(entry.custom_data) as { prompt_text?: string }) : {};
    return String(custom.prompt_text ?? '');
  } catch {
    return '';
  }
}

export class KikiClient {
  private readonly opts: KikiClientOptions;
  private readonly voiceCache = new Map<string, VoiceCacheEntry>();

  constructor(opts: KikiClientOptions) {
    this.opts = opts;
  }

  private baseHeaders(): KikiHeaders {
    return {
      'User-Agent': this.opts.userAgent,
      Origin: this.opts.baseUrl,
      Referer: `${this.opts.baseUrl}/ai-voice-cloning/id`,
      Accept: 'application/json, text/plain, */*',
    };
  }

  /** True if the session cookie authenticates with KikiVoice. */
  async checkStatus(): Promise<boolean> {
    const resp = await this.opts.transport.get(`${this.opts.baseUrl}/jsapi/auth/check-status`, {
      headers: this.baseHeaders(),
    });
    const data = jsonOrThrow(await resp.text(), resp.status, 'check-status');
    return Boolean(data.authenticated);
  }

  private async getSig(): Promise<SigInfo> {
    const resp = await this.opts.transport.get(`${this.opts.baseUrl}/jsapi/get-cloning-file-sig`, {
      headers: this.baseHeaders(),
    });
    const data = jsonOrThrow(await resp.text(), resp.status, 'get-cloning-file-sig');
    const sig = String(data.sig ?? '');
    // Empty sig ⇒ the session is not authenticated (get-sig returns an auth-error JSON without the
    // url fields). Bail with a clear message before an empty voiceListUrl reaches net.request('').
    if (!sig) {
      throw new KikiError(
        'KikiVoice tidak mengembalikan signature kloning — sesi belum terautentikasi. Buka Settings → 配音/TTS → KikiVoice → Connect.',
        true,
      );
    }
    return {
      sig,
      createVoiceUrl: String(data.kiki_voice_microservices_api_create_voice_url ?? ''),
      voiceListUrl: String(data.kiki_voice_microservices_api_voice_list_url ?? ''),
    };
  }

  private async fetchVoiceList(sig: SigInfo): Promise<VoiceListEntry[]> {
    const resp = await this.opts.transport.get(sig.voiceListUrl, {
      params: { sig: sig.sig },
      headers: this.baseHeaders(),
    });
    const data = jsonOrThrow(await resp.text(), resp.status, 'get-voice-list');
    return Array.isArray(data.voice_list) ? (data.voice_list as VoiceListEntry[]) : [];
  }

  private async uploadVoice(sig: SigInfo, ref: KikiFilePart, voiceName: string): Promise<string> {
    // KikiVoice expects voice_name/denoise/asr/sig as URL QUERY params (httpx params= in OpenCut-AI),
    // NOT multipart form fields — only the voice-file travels in the multipart body.
    // (Spike-validated: fields-in-body → errcode -2 invalid params; params-in-query → errcode 0.)
    const upUrl = `${sig.createVoiceUrl}?${new URLSearchParams({ voice_name: voiceName, denoise: '1', asr: '1', sig: sig.sig }).toString()}`;
    const resp = await this.opts.transport.postForm(
      upUrl,
      {},
      { 'voice-file': ref },
      { headers: this.baseHeaders(), timeoutMs: 180_000 },
    );
    const data = jsonOrThrow(await resp.text(), resp.status, 'create-voice');
    const errcode = Number(data.errcode ?? 0);
    if (errcode !== 0) {
      if (errcode === -3) {
        throw new KikiError(
          'KikiVoice custom-voice library is full (10/10). Delete old custom voices at kikivoice.ai to free a slot, then retry.',
        );
      }
      throw new KikiError(`upload_voice failed: ${JSON.stringify(data).slice(0, 200)}`);
    }
    const voiceId = String(data.voice_id ?? '');
    if (!voiceId) throw new KikiError(`upload_voice returned no voice_id: ${JSON.stringify(data).slice(0, 200)}`);
    return voiceId;
  }

  private async findReusableVoice(sig: SigInfo, name: string): Promise<{ voiceId: string; promptText: string } | null> {
    const list = await this.fetchVoiceList(sig);
    const now = Math.floor(Date.now() / 1000);
    for (const voice of list) {
      if (voice.voice_name !== name) continue;
      const create = Number(voice.create_time ?? 0);
      const ttl = Number(voice.ttl ?? 0);
      const remaining = create && ttl ? create + ttl - now : 0;
      if (remaining < MIN_REUSE_REMAINING_TTL_S) continue;
      return { voiceId: String(voice.voice_id ?? ''), promptText: promptFromEntry(voice) };
    }
    return null;
  }

  /** Resolve a KikiVoice custom voice for `opencutVoiceId`: reuse cached/server-side, else upload the ref. */
  private async resolveVoice(opencutVoiceId: string): Promise<{ voiceId: string; promptText: string; sig: SigInfo }> {
    const cached = this.voiceCache.get(opencutVoiceId);
    const now = Date.now();
    if (cached && now - cached.cachedAt < VOICE_CACHE_TTL_MS) {
      const sig = await this.getSig();
      return { voiceId: cached.voiceId, promptText: cached.promptText, sig };
    }
    const sig = await this.getSig();
    const reusable = await this.findReusableVoice(sig, opencutVoiceId);
    if (reusable?.voiceId) {
      this.voiceCache.set(opencutVoiceId, { voiceId: reusable.voiceId, promptText: reusable.promptText, cachedAt: now });
      return { voiceId: reusable.voiceId, promptText: reusable.promptText, sig };
    }
    const ref = await this.opts.getRefAudio(opencutVoiceId);
    const voiceId = await this.uploadVoice(sig, ref, opencutVoiceId);
    const promptText = await this.fetchPromptText(sig, voiceId);
    this.voiceCache.set(opencutVoiceId, { voiceId, promptText, cachedAt: now });
    return { voiceId, promptText, sig };
  }

  private async fetchPromptText(sig: SigInfo, voiceId: string): Promise<string> {
    const list = await this.fetchVoiceList(sig);
    const entry = list.find((v) => v.voice_id === voiceId);
    return entry ? promptFromEntry(entry) : '';
  }

  private captureQuota(data: Record<string, unknown>): void {
    const sink = this.opts.quotaSink;
    if (!sink) return;
    const quota = data.quota_info;
    if (!quota || typeof quota !== 'object') return;
    const q = quota as Record<string, unknown>;
    // Number(x) || undefined would mask a legitimate 0 (quota exhausted: 0 || undefined === undefined);
    // Number.isFinite lets "0"/0 surface as a real exhausted-quota signal.
    const finite = (v: unknown): number | undefined => {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    sink({
      available: finite(q.available_count),
      used: finite(q.used_count),
      max: finite(q.max_count),
      publicIp: typeof q.public_ip === 'string' ? q.public_ip : undefined,
      nextResetDays: typeof q.next_reset_days === 'number' ? q.next_reset_days : undefined,
      capturedAtMonotonic: monotonicMs(),
    });
  }

  private async createTask(voiceId: string, promptText: string, text: string, lang: 'id' | 'en'): Promise<string> {
    const promptLanguage = lang === 'id' ? 'Indonesian' : 'English';
    const fields: Record<string, string> = {
      text,
      clone_source_voice_custom_voice_id: voiceId,
      lang_name_code: lang,
      emotion: 'normal',
      intensity: 'normal',
      clone_source_voice_prompt_text: promptText,
      clone_source_voice_prompt_text_language: promptLanguage,
      clone_source_voice_gender: '0',
      model_type: this.opts.model,
      speed: this.opts.speed ?? '1',
      volume: '100',
      audio_format: 'mp3',
      audio_high_quality: '0',
      model_version_text: 'default',
    };
    const url = `${this.opts.baseUrl}/jsapi/create-new-clone-task`;
    let lastError = '';
    let revalidated = false;
    for (let attempt = 0; attempt <= CREATE_MAX_RETRIES; attempt++) {
      const resp = await this.opts.transport.postForm(url, fields, {}, {
        headers: this.baseHeaders(),
        timeoutMs: 60_000,
      });
      if (resp.status === 429 || resp.status === 503 || resp.status >= 500) {
        // Transient server overload / rate-limit. KikiVoice returns 503 with an HTML body during
        // heavy load; without this branch jsonOrThrow hard-fails on the non-JSON body. Retry instead.
        lastError = `create_task transient (HTTP ${resp.status})`;
        if (attempt < CREATE_MAX_RETRIES) {
          const wait = CREATE_BACKOFF_MS[Math.min(attempt, CREATE_BACKOFF_MS.length - 1)];
          await sleep(wait);
          continue;
        }
        throw new KikiError(lastError);
      }
      const data = jsonOrThrow(await resp.text(), resp.status, 'create-new-clone-task');
      this.captureQuota(data);
      if (data.success) {
        // job_id nests under data.data.job_id (KikiVoice 2026 response shape); fall back to top-level.
        const nested = data.data && typeof data.data === 'object' ? (data.data as Record<string, unknown>) : {};
        const jobId = String(data.job_id ?? nested.job_id ?? nested.task_id ?? '');
        if (!jobId) throw new KikiError(`create_task returned no job_id: ${JSON.stringify(data).slice(0, 200)}`);
        return jobId;
      }
      const errorCode = Number(data.error_code ?? 0);
      if (errorCode === 503 || errorCode === 429) {
        // Body-level transient/rate-limit (HTTP 200 + error_code). Back off + retry.
        lastError = `create_task ${errorCode} (transient/rate-limit)`;
        if (attempt < CREATE_MAX_RETRIES) {
          await sleep(CREATE_BACKOFF_MS[Math.min(attempt, CREATE_BACKOFF_MS.length - 1)]);
          continue;
        }
        throw new KikiError(lastError);
      }
      if (errorCode === HUMAN_VERIFICATION_ERROR_CODE) {
        if (this.opts.onRevalidateNeeded && !revalidated) {
          revalidated = true;
          const cleared = await this.opts.onRevalidateNeeded();
          if (cleared) continue;
        }
        throw new KikiError('KikiVoice requires human verification (777) — re-validate the session', true);
      }
      throw new KikiError(`create_task failed: ${JSON.stringify(data).slice(0, 200)}`);
    }
    throw new KikiError(lastError || 'kiki create_task failed');
  }

  private async pollJob(jobId: string, maxWaitMs = 180_000): Promise<string> {
    const url = `${this.opts.baseUrl}/jsapi/get-job-task-status`;
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const resp = await this.opts.transport.get(url, { params: { job_id: jobId }, headers: this.baseHeaders(), timeoutMs: 30_000 });
      const data = jsonOrThrow(await resp.text(), resp.status, 'get-job-task-status');
      const audioUrl = String(data.audiourl ?? '');
      if (audioUrl) return audioUrl;
      const err = Number(data.error_code ?? 0);
      if (err) throw new KikiError(`job ${jobId} errored: ${JSON.stringify(data).slice(0, 200)}`);
      await sleep(4000);
    }
    throw new KikiError(`timed out waiting for KikiVoice job ${jobId}`);
  }

  /** Download synthesized audio from the KikiVoice CDN (no cookie needed). */
  async downloadAudio(audioUrl: string): Promise<Buffer> {
    const resp = await this.opts.transport.get(audioUrl, { timeoutMs: 60_000 });
    if (resp.status >= 400) throw new KikiError(`audio download HTTP ${resp.status}`);
    return resp.bytes();
  }

  /** Synthesize `text` cloning the ref for `opencutVoiceId`. Returns MP3 bytes.
   *  kiki_core rejects text > 1000 chars (TEXT_TOO_LONG), so long narration is split on sentence
   *  boundaries into ≤900-char chunks, each synthed, and the MP3 bytes concatenated. */
  async generate(opencutVoiceId: string, text: string, language: string): Promise<Buffer> {
    if (!text || !text.trim()) throw new KikiError('KikiVoice generate: empty text');
    const lang: 'id' | 'en' = language === 'id' ? 'id' : 'en';
    // resolveVoice → getSig validates the session (empty sig ⇒ not authenticated, throws a clear
    // message). We deliberately do NOT gate on checkStatus() here — that endpoint returns
    // authenticated=false even when the session IS synth-ready (validated at boot), which caused
    // a false "belum terhubung" block. The real auth test is createTask below; a stale session
    // surfaces there with a concrete 777/auth error and onRevalidateNeeded re-solves GeeTest.
    const { voiceId, promptText } = await this.resolveVoice(opencutVoiceId || 'joni');
    const chunks = splitForKiki(text, 900);
    const audioChunks: Buffer[] = [];
    for (const chunk of chunks) {
      const jobId = await this.createTask(voiceId, promptText, chunk, lang);
      const audioUrl = await this.pollJob(jobId);
      const audio = await this.downloadAudio(audioUrl);
      if (!audio.length) throw new KikiError(`KikiVoice returned empty audio for job ${jobId}`);
      audioChunks.push(audio);
    }
    return Buffer.concat(audioChunks);
  }

  invalidateVoiceCache(): void {
    this.voiceCache.clear();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Split `text` into chunks ≤ maxLen chars on sentence boundaries (Indonesian/English enders).
 * kiki_core caps each synth request at 1000 chars; a single over-long sentence is hard-split on
 * whitespace. Always returns at least one chunk.
 */
function splitForKiki(text: string, maxLen: number): string[] {
  const clean = text.trim();
  if (clean.length <= maxLen) return [clean];
  const sentences = clean.match(/[^.!?。！？\n]+[.!?。！？]?/g) ?? [clean];
  const chunks: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (s.length > maxLen) {
      if (cur.trim()) { chunks.push(cur.trim()); cur = ''; }
      // hard-split a single over-long sentence on whitespace
      let w = '';
      for (const word of s.split(/(\s+)/)) {
        if (word.length > maxLen) {
          // Space-less scripts (Chinese/Japanese/Thai): a single "word" can itself
          // exceed maxLen, so the (w+word) check would never split it. Flush what we
          // have, then char-split the over-long word so no chunk violates the limit.
          if (w.trim()) { chunks.push(w.trim()); w = ''; }
          for (let i = 0; i < word.length; i += maxLen) chunks.push(word.slice(i, i + maxLen));
          continue;
        }
        if ((w + word).length > maxLen) { if (w.trim()) chunks.push(w.trim()); w = word; }
        else w += word;
      }
      if (w.trim()) cur = w;
    } else if ((cur + s).length > maxLen) {
      if (cur.trim()) chunks.push(cur.trim());
      cur = s;
    } else cur += s;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.length ? chunks : [clean.slice(0, maxLen)];
}

function monotonicMs(): number {
  // performance.now() is monotonic and matches the badge's staleness semantics.
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
