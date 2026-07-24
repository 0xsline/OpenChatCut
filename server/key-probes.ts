// Server detection table of "Test Connection" in the settings panel: one minimal real authentication request for each manufacturer page
// (read-only endpoint or near-zero cost call), verify that the Key + Base URL is available. The key comes from keystore,
// Or the request body overrides (the temporary value that has not been saved in the panel will only take effect for this detection and will not be saved).
// Security invariant: The result only contains ok / message / status / latencyMs, and never echoes any key value;
// The manufacturer's error copy is flattened and truncated before entering the message. Align the endpoints and authentication headers of each vite-plugin-* one by one
// Real call writing method (Doubao three header / MiniMax base_resp / Gemini x-goog-api-key...).
import { getKey, KEY_NAMES, type KeyName } from './keystore.ts';
import { r2Probe } from './r2.ts';
import { mediaDirProbe, mediaDirPostCheck, mediaDirOkText } from './media-dir.ts';
import {
  AI_SDK_BASE_URL_FORMAT,
  resolveLlmBaseUrl,
} from './llm-config.ts';
import {
  LLM_PROVIDER_PRESETS,
  llmProviderConfigNames,
  protocolForProvider,
  type LlmProvider,
} from '../shared/llm-providers.ts';

export interface ProbeResult {
  ok: boolean;
  message: string;
  status?: number;
  latencyMs?: number;
  models?: string[];
}

type Get = (name: KeyName) => string;

interface ProbeDef {
  /** Starting threshold:OR of AND group(bean bag = App ID + Access Key Qi) */
  readonly needs: readonly (readonly KeyName[])[];
  readonly run: (get: Get) => Promise<Response>;
  /** 2xx It may also be a manufacturer-level failure(MiniMax base_resp);Return error text,null = What a success */
  readonly postCheck?: (bodyText: string) => string | null;
  /** Custom conclusion on success(Non-network checks such as local disk probes);null/Default = General "Connection successful" */
  readonly okText?: (bodyText: string) => string | null;
  /** Parse a successful model-catalog response. Only LLM provider pages use this. */
  readonly models?: (bodyText: string) => string[];
}

const TIMEOUT_MS = 12_000;
const t = (): AbortSignal => AbortSignal.timeout(TIMEOUT_MS);
const base = (get: Get, name: KeyName, def: string): string => (get(name) || def).replace(/\/+$/, '');
const bearer = (key: string): Record<string, string> => ({ Authorization: `Bearer ${key}` });
function llmProbe(provider: LlmProvider): ProbeDef {
  const names = llmProviderConfigNames(provider);
  const protocol = protocolForProvider(provider);
  const apiKeyName = names.apiKey as KeyName;
  const baseUrlName = names.baseUrl as KeyName;
  return {
    needs: [[apiKeyName]],
    run: (get) => {
      const key = get(apiKeyName);
      const headers = protocol === 'anthropic'
        ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
        : bearer(key);
      const root = resolveLlmBaseUrl(provider, get(baseUrlName), AI_SDK_BASE_URL_FORMAT);
      return fetch(`${root}/models`, { signal: t(), headers });
    },
    models: parseModelCatalog,
  };
}

export function parseModelCatalog(bodyText: string): string[] {
  try {
    const body = JSON.parse(bodyText) as {
      data?: Array<{ id?: unknown; name?: unknown }>;
      models?: Array<{ id?: unknown; name?: unknown }>;
    };
    const rows = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
    return [...new Set(rows
      .map((row) => typeof row.id === 'string' ? row.id : typeof row.name === 'string' ? row.name : '')
      .map((id) => id.trim())
      .filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** The manufacturer's error copy is flattened before entering the results.:Go to line breaks and truncation. Never splice any key values. */
export function sanitize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 140);
}

/** MiniMax:HTTP 200 Authentication may also fail,The truth is base_resp.status_code(0 = success)。 */
export function minimaxPostCheck(bodyText: string): string | null {
  try {
    const body = JSON.parse(bodyText) as { base_resp?: { status_code?: number; status_msg?: string } };
    const code = body.base_resp?.status_code ?? 0;
    if (code === 0) return null;
    const msg = body.base_resp?.status_msg ?? '';
    const hint = code === 1004 ? '(Authentication failed, check Key）' : '';
    return `MiniMax base_resp ${code}${msg ? ` · ${sanitize(msg)}` : ''}${hint}`;
  } catch {
    return null; // Non-JSON 2xx are counted as successful
  }
}

// The four capability pages of MiniMax share one detection: POST /v1/get_voice (free read-only;
// The voice_cloning list is usually empty, minimal response).
const minimaxProbe: ProbeDef = {
  needs: [['MINIMAX_API_KEY']],
  run: (get) => fetch(`${base(get, 'MINIMAX_BASE_URL', 'https://api.minimaxi.com')}/v1/get_voice`, {
    method: 'POST', signal: t(),
    headers: { 'Content-Type': 'application/json', ...bearer(get('MINIMAX_API_KEY')) },
    body: JSON.stringify({ voice_type: 'voice_cloning' }),
  }),
  postCheck: minimaxPostCheck,
};

/** page key(with settingsSchema manufacturer page key Same name)→ Detection definition. */
export const PROBES: Record<string, ProbeDef> = {
  ...Object.fromEntries(LLM_PROVIDER_PRESETS.map((preset) => [
    `llm/${preset.id}`,
    llmProbe(preset.id),
  ])),
  'image/openai': {
    needs: [['IMAGE_API_KEY'], ['OPENAI_API_KEY']],
    run: (get) => fetch(`${base(get, 'IMAGE_BASE_URL', 'https://api.openai.com')}/v1/models`, {
      signal: t(), headers: bearer(get('IMAGE_API_KEY') || get('OPENAI_API_KEY')),
    }),
  },
  'image/gemini': {
    needs: [['GEMINI_API_KEY']],
    run: (get) => fetch(`${base(get, 'GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com')}/v1beta/models?pageSize=1`, {
      signal: t(), headers: { 'x-goog-api-key': get('GEMINI_API_KEY') },
    }),
  },
  'image/minimax': minimaxProbe,
  'voice/elevenlabs': {
    needs: [['ELEVENLABS_API_KEY']],
    run: (get) => fetch(`${base(get, 'ELEVENLABS_BASE_URL', 'https://api.elevenlabs.io')}/v1/models`, {
      signal: t(), headers: { 'xi-api-key': get('ELEVENLABS_API_KEY') },
    }),
  },
  // openpeech does not have free probing endpoints, synthesizing 1 word is the minimum real verification (the cost is negligible).
  'voice/doubao': {
    needs: [['DOUBAO_TTS_APP_ID', 'DOUBAO_TTS_ACCESS_KEY']],
    run: (get) => fetch(`${base(get, 'DOUBAO_TTS_BASE_URL', 'https://openspeech.bytedance.com')}/api/v3/tts/unidirectional`, {
      method: 'POST', signal: t(),
      headers: {
        'Content-Type': 'application/json',
        'X-Api-App-Id': get('DOUBAO_TTS_APP_ID'),
        'X-Api-Access-Key': get('DOUBAO_TTS_ACCESS_KEY'),
        'X-Api-Resource-Id': get('DOUBAO_TTS_RESOURCE_ID') || 'seed-tts-2.0',
      },
      body: JSON.stringify({
        user: { uid: 'openchatcut-probe' },
        req_params: { text: 'test', speaker: 'zh_female_vv_uranus_bigtts', audio_params: { format: 'mp3', sample_rate: 24_000 } },
      }),
    }),
  },
  'voice/minimax': minimaxProbe,
  'video/seedance': {
    needs: [['SEEDANCE_API_KEY']],
    run: (get) => fetch(`${base(get, 'SEEDANCE_BASE_URL', 'https://ark.cn-beijing.volces.com/api/v3')}/contents/generations/tasks?page_num=1&page_size=1`, {
      signal: t(), headers: bearer(get('SEEDANCE_API_KEY')),
    }),
  },
  'video/kling': {
    needs: [['KLING_API_KEY']],
    run: (get) => fetch(`${base(get, 'KLING_BASE_URL', 'https://api-singapore.klingai.com')}/v1/videos/text2video?pageNum=1&pageSize=1`, {
      signal: t(), headers: bearer(get('KLING_API_KEY')),
    }),
  },
  'video/hailuo': minimaxProbe,
  'music/mureka': {
    needs: [['MUREKA_API_KEY']],
    run: (get) => fetch(`${base(get, 'MUREKA_BASE_URL', 'https://api.mureka.ai')}/v1/account/billing`, {
      signal: t(), headers: bearer(get('MUREKA_API_KEY')),
    }),
  },
  'music/minimax': minimaxProbe,
  // /v1/search has been opened to anonymous users (the measured number is 200 without key), and the key; collections cannot be detected
  // It is the account binding endpoint, and the fake key is stable 401.
  'stock/pexels': {
    needs: [['PEXELS_API_KEY']],
    run: (get) => fetch('https://api.pexels.com/v1/collections?per_page=1', {
      signal: t(), headers: { Authorization: get('PEXELS_API_KEY') },
    }),
  },
  // Pixabay official design: key takes the query parameter (the server is directly connected to HTTPS, the same shape as the stock plug-in).
  'stock/pixabay': {
    needs: [['PIXABAY_API_KEY']],
    run: (get) => {
      const params = new URLSearchParams({ key: get('PIXABAY_API_KEY'), q: 'sky', per_page: '3' });
      return fetch(`https://pixabay.com/api/?${params.toString()}`, { signal: t() });
    },
  },
  // Unsplash: The search endpoint requires Client-ID, fake key 401.
  'stock/unsplash': {
    needs: [['UNSPLASH_ACCESS_KEY']],
    run: (get) => fetch('https://api.unsplash.com/search/photos?query=sky&per_page=1', {
      signal: t(), headers: { Authorization: 'Client-ID ' + get('UNSPLASH_ACCESS_KEY') },
    }),
  },
  // Freesound: token uses query (same shape as stock plug-in), false token 401.
  'stock/freesound': {
    needs: [['FREESOUND_API_KEY']],
    run: (get) => {
      const params = new URLSearchParams({ query: 'wind', page_size: '1', fields: 'id', token: get('FREESOUND_API_KEY') });
      return fetch('https://freesound.org/apiv2/search/text/?' + params.toString(), { signal: t() });
    },
  },
  'transcription/assemblyai': {
    needs: [['ASSEMBLYAI_API_KEY']],
    run: (get) => fetch('https://api.assemblyai.com/v2/transcript?limit=1', {
      signal: t(), headers: { authorization: get('ASSEMBLYAI_API_KEY') },
    }),
  },
  'sandbox/e2b': {
    needs: [['E2B_API_KEY']],
    run: (get) => fetch('https://api.e2b.dev/sandboxes', {
      signal: t(), headers: { 'X-API-KEY': get('E2B_API_KEY') },
    }),
  },
  'web/firecrawl': {
    needs: [['FIRECRAWL_API_KEY']],
    run: (get) => fetch('https://api.firecrawl.dev/v2/team/credit-usage', {
      signal: t(), headers: bearer(get('FIRECRAWL_API_KEY')),
    }),
  },
  // S3 HeadBucket is sent via SDK (SigV4 signature cannot be manually fetched), r2.ts synthesizes Response:
  // 200=The bucket exists and has been authenticated; 403/404 goes to classifyStatus; the network layer throws it to networkMessage as it is.
  'storage/r2': {
    needs: [['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']],
    run: (get) => r2Probe(get),
  },
  // Local saving directory: disk check (create directory + write and delete detection files), non-network request. Empty group needs = not filled in
  // It can also be tested (if not set = use the default directory, it is legal).
  'storage/local': {
    needs: [[]],
    run: (get) => mediaDirProbe(get),
    postCheck: mediaDirPostCheck,
    okText: mediaDirOkText,
  },
};

/** Not 2xx Status → Conclusions that users can understand(Authentication / address / Current limiting / Others)。 */
export function classifyStatus(status: number, bodyText: string): ProbeResult {
  if (status === 401 || status === 403) {
    return { ok: false, status, message: `Authentication failed (HTTP ${status}）· Key Invalid, expired or no permissions for this interface` };
  }
  if (status === 404) {
    return { ok: false, status, message: 'probe endpoint 404 · Base URL It may be filled in incorrectly (or the service does not recognize this detection path)' };
  }
  if (status === 429) {
    return { ok: true, status, message: 'Authentication passed (HTTP 429 current limit, description Key valid)' };
  }
  const detail = sanitize(bodyText);
  return { ok: false, status, message: `HTTP ${status}${detail ? ` · ${detail}` : ''}` };
}

/** Network layer failure(Can't connect / timeout)≠ Key Error,Copy clearly differentiates,And prompts that an agent may be required. */
export function networkMessage(error: unknown): string {
  const raw = error instanceof Error
    ? `${error.name}: ${error.message}${error.cause instanceof Error ? `（${error.cause.message}）` : ''}`
    : String(error);
  // Note: undici comes with a 10s connection timeout, which is often triggered before our 12s overall gate, and does not write a dead number of seconds.
  if (/timeout|abort/i.test(raw)) {
    return 'Connection timeout · The service is unreachable or the network is restricted (a proxy may be required), which does not mean Key Error';
  }
  return `Network unreachable · ${sanitize(raw)} · This machine cannot connect to the service (may require a proxy), it does not mean Key Error`;
}

/** temporary storage overrides(In the whitelist, an empty string represents removal for this test.)Overwrite the stored value. */
export function makeGetter(overrides: Record<string, unknown>): Get {
  const clean = new Map<string, string>();
  for (const [name, raw] of Object.entries(overrides)) {
    if (!(KEY_NAMES as readonly string[]).includes(name)) continue; // Discarded outside the whitelist
    clean.set(name, String(raw ?? '').trim());
  }
  if (clean.has('LLM_BASE_URL') && !clean.has('LLM_BASE_URL_FORMAT')) {
    clean.set('LLM_BASE_URL_FORMAT', clean.get('LLM_BASE_URL') ? AI_SDK_BASE_URL_FORMAT : '');
  }
  return (name) => clean.has(name) ? clean.get(name)! : getKey(name);
}

/** Run a connectivity probe of the manufacturer's page. Not configured / The unknown page is returned before the request is made.,No internet. */
export async function runProbe(page: string, overrides: Record<string, unknown>): Promise<ProbeResult> {
  const probe = PROBES[page];
  if (!probe) return { ok: false, message: 'This manufacturer does not currently support connection testing' };
  const get = makeGetter(overrides);
  const ready = probe.needs.some((group) => group.every((n) => get(n).length > 0));
  if (!ready) return { ok: false, message: 'Not filled in yet API Key · After filling in, click test' };
  const started = Date.now();
  try {
    const response = await probe.run(get);
    const latencyMs = Date.now() - started;
    const bodyText = await response.text().catch(() => '');
    if (response.ok) {
      const vendorError = probe.postCheck?.(bodyText) ?? null;
      if (vendorError) return { ok: false, status: response.status, latencyMs, message: vendorError };
      const models = probe.models?.(bodyText);
      const modelText = models
        ? models.length > 0 ? ` · Read ${models.length} models` : ' · The interface did not return a list of models'
        : '';
      const okText = probe.okText?.(bodyText) ?? 'Connection successful · Authentication passed';
      return {
        ok: true,
        status: response.status,
        latencyMs,
        message: `${okText}${modelText} · ${latencyMs}ms`,
        ...(models ? { models } : {}),
      };
    }
    return { ...classifyStatus(response.status, bodyText), latencyMs };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, message: networkMessage(error) };
  }
}
