// Set the server detection table of the "Test Connection" panel: the lightest real authentication request for each provider page
// (read-only endpoint or near-zero cost call), verify that the Key + Base URL is available. The key comes from keystore,
// Or the request body overrides (the temporary value that has not been saved in the panel will only take effect for this detection and will not be saved).
// Security invariant: The result only contains ok / message / status / latencyMs, and never echoes any key value;
// The provider's error copy is flattened and truncated before entering the message. Align the endpoints and authentication headers of each vite-plugin-* one by one
// Real call writing method (beanbao three header / MiniMax base_resp / Gemini x-goog-api-key...).
import { ProxyAgent } from 'undici';
import { environmentProxyUrl, proxyDispatcher } from './outbound-proxy.ts';
import { getKey, KEY_NAMES, type KeyName } from './keystore.ts';
import { r2Probe } from './r2.ts';
import { mediaDirProbe, mediaDirPostCheck, mediaDirOkText } from './media-dir.ts';
import { checkDataDir, readDataDirPointer } from './data-dir.ts';
import { DATA_DIR_ENV, defaultRootDir, runtimeProfile } from './runtime-profile.ts';
import {
  AI_SDK_BASE_URL_FORMAT,
  resolveLlmBaseUrl,
} from './llm-config.ts';
import {
  LLM_PROVIDER_PRESETS,
  isLocalLlmProvider,
  llmProviderConfigNames,
  protocolForProvider,
  type LlmProvider,
} from '../shared/llm-providers.ts';
import { versionedApiBaseUrl } from './plugins/media-provider-config.ts';
import { xaiOauthAccessToken } from './xai-oauth-session.ts';
import {
  classifyStatus,
  networkMessage,
  sanitizeProbeText,
  type ProbeResult,
} from './key-probe-result.ts';
export { classifyStatus, networkMessage, type ProbeResult } from './key-probe-result.ts';
// Proxy-aware fetch: attaches the configured outbound proxy (keystore
// PROXY_URL or HTTPS_PROXY/HTTP_PROXY env) via undici dispatcher.
type FetchInit = Parameters<typeof fetch>[1] & { dispatcher?: unknown };

// Probes send REAL stored credentials to a user/agent-settable base URL.
// Loopback and private hosts stay allowed (local models and LAN gateways are
// legitimate), but cloud metadata / link-local targets and credential-bearing
// or non-http(s) URLs never are — those only appear in SSRF exfil attempts.
export function probeUrlError(url: RequestInfo | URL): string | null {
  let parsed: URL;
  try {
    parsed = new URL(String(url));
  } catch {
    return '探测地址不是合法 URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `探测地址协议不支持:${parsed.protocol}`;
  }
  if (parsed.username || parsed.password) return '探测地址不允许携带内嵌凭据';
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host) || host.startsWith('fe80:')
    || host === 'metadata.google.internal') {
    return '探测地址指向云元数据/链路本地网段,已拒绝';
  }
  return null;
}

const fetchWithProxy = (url: RequestInfo | URL, init?: FetchInit): Promise<Response> => {
  const unsafe = probeUrlError(url);
  if (unsafe) return Promise.reject(new Error(unsafe));
  return fetch(url, { ...init, dispatcher: proxyDispatcher() } as RequestInit);
};


type Get = (name: KeyName) => string;

interface ProbeDef {
  /** Starting test threshold: OR AND group (doubao = App ID + Access Key together) */
  readonly needs: readonly (readonly KeyName[])[];
  readonly run: (get: Get) => Promise<Response>;
  /** 2xx may also be a provider-level failure (MiniMax base_resp); return error text, null = true success */
  readonly postCheck?: (bodyText: string) => string | null;
  /** Custom conclusion when successful (non-network check such as local disk probe); null/default = general "connection successful" */
  readonly okText?: (bodyText: string) => string | null;
  /** Parse a successful model-catalog response. Only LLM provider pages use this. */
  readonly models?: (bodyText: string) => string[];
}

const TIMEOUT_MS = 12_000;
const t = (): AbortSignal => AbortSignal.timeout(TIMEOUT_MS);
const PROXY_PROBE_URL = 'https://www.gstatic.com/generate_204';

function proxyProbeUrl(overrides: Record<string, unknown>): string {
  if (Object.hasOwn(overrides, 'PROXY_URL')) return String(overrides.PROXY_URL ?? '').trim();
  return getKey('PROXY_URL').trim() || environmentProxyUrl();
}

/** Storage-root writability check: a local disk probe, never a network request. */
export async function runDataDirProbe(overrides: Record<string, unknown>): Promise<ProbeResult> {
  const profile = runtimeProfile();
  if (process.env[DATA_DIR_ENV]?.trim()) {
    return { ok: false, message: `目录由 ${DATA_DIR_ENV} 固定，无法在设置中修改` };
  }
  const raw = Object.hasOwn(overrides, DATA_DIR_ENV)
    ? String(overrides[DATA_DIR_ENV] ?? '')
    : readDataDirPointer() ?? '';
  const started = Date.now();
  const body = await checkDataDir(raw, defaultRootDir(profile));
  const latencyMs = Date.now() - started;
  return body.ok
    ? { ok: true, latencyMs, message: body.note ?? '目录可写' }
    : { ok: false, latencyMs, message: body.error ?? '目录检查失败' };
}

/** Test the saved proxy or the unsaved value currently shown in the settings field. */
export async function runProxyProbe(overrides: Record<string, unknown>): Promise<ProbeResult> {
  const proxyUrl = proxyProbeUrl(overrides);
  if (!proxyUrl) return { ok: false, message: '尚未填写代理地址，且未检测到系统代理环境变量' };
  let dispatcher: ProxyAgent;
  try {
    dispatcher = new ProxyAgent(proxyUrl);
  } catch {
    return { ok: false, message: '代理地址格式无效，请填写 http://host:port 或 https://host:port' };
  }
  const started = Date.now();
  try {
    const response = await fetch(PROXY_PROBE_URL, { signal: t(), dispatcher } as RequestInit);
    const latencyMs = Date.now() - started;
    if (!response.ok) return { ok: false, status: response.status, latencyMs, message: `代理已连接，但外网探测返回 HTTP ${response.status}` };
    return { ok: true, status: response.status, latencyMs, message: `代理连接成功 · 外网可达 · ${latencyMs}ms` };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, message: proxyNetworkMessage(error) };
  } finally {
    await dispatcher.close();
  }
}

function proxyNetworkMessage(error: unknown): string {
  const message = networkMessage(error).replace(/，不代表 Key 错误$/, '');
  return `代理连接失败 · ${message}`;
}
const base = (get: Get, name: KeyName, def: string): string => (get(name) || def).replace(/\/+$/, '');
const bearer = (key: string): Record<string, string> => ({ Authorization: `Bearer ${key}` });
function llmProbe(provider: LlmProvider): ProbeDef {
  const names = llmProviderConfigNames(provider);
  const protocol = protocolForProvider(provider);
  const apiKeyName = names.apiKey as KeyName;
  const baseUrlName = names.baseUrl as KeyName;
  const isLocal = isLocalLlmProvider(provider);
  return {
    needs: isLocal ? [[]] : [[apiKeyName]],
    run: (get) => {
      const key = get(apiKeyName);
      const headers = protocol === 'anthropic'
        ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
        : protocol === 'google'
          ? { 'x-goog-api-key': key }
          : key ? bearer(key) : {};
      const root = resolveLlmBaseUrl(provider, get(baseUrlName), AI_SDK_BASE_URL_FORMAT);
      return fetchWithProxy(`${root}/models`, { signal: t(), headers });
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

/** The provider's error copy is flattened before entering the results: line breaks and truncation are removed. Never splice any key values.*/
export function sanitize(text: string): string {
  return sanitizeProbeText(text);
}

/** MiniMax: HTTP 200 may also cause authentication failure, the truth is in base_resp.status_code(0 = success).*/
export function minimaxPostCheck(bodyText: string): string | null {
  try {
    const body = JSON.parse(bodyText) as { base_resp?: { status_code?: number; status_msg?: string } };
    const code = body.base_resp?.status_code ?? 0;
    if (code === 0) return null;
    const msg = body.base_resp?.status_msg ?? '';
    const hint = code === 1004 ? '（鉴权失败，检查 Key）' : '';
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

const atlasMusicProbe: ProbeDef = {
  needs: [['ATLASCLOUD_API_KEY']],
  run: async (get) => {
    const root = base(get, 'ATLASCLOUD_API_BASE', 'https://api.atlascloud.ai/api/v1');
    const response = await fetchWithProxy(`${root}/model/prediction/openchatcut-credential-probe`, {
      signal: t(), headers: bearer(get('ATLASCLOUD_API_KEY')),
    });
    if (response.status !== 404) return response;
    const body = await response.text().catch(() => '');
    try {
      const payload = JSON.parse(body) as { code?: number; message?: string };
      if (payload.code === 404 && payload.message === 'not found') {
        return new Response('{"authenticated":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    } catch {
      // Preserve an unrecognized 404 so the common classifier reports a bad Base URL.
    }
    return new Response(body, { status: 404, headers: response.headers });
  },
};

// BytePlus ModelArk: one account/key serves image (Seedream) and video (Seedance) alike —
// both capability pages share this /models detection, same as minimaxProbe above.
const byteplusProbe: ProbeDef = {
  needs: [['BYTEPLUS_API_KEY']],
  run: (get) => fetch(`${base(get, 'BYTEPLUS_BASE_URL', 'https://ark.ap-southeast.bytepluses.com/api/v3')}/models`, {
    signal: t(), headers: bearer(get('BYTEPLUS_API_KEY')),
  }),
  models: parseModelCatalog,
};

const openAiMediaProbe: ProbeDef = {
  needs: [['OPENAI_API_KEY']],
  run: (get) => fetch(`${versionedApiBaseUrl(base(get, 'IMAGE_BASE_URL', 'https://api.openai.com'), 'v1')}/models`, {
    signal: t(), headers: bearer(get('OPENAI_API_KEY')),
  }),
};

const geminiMediaProbe: ProbeDef = {
  needs: [['GEMINI_API_KEY']],
  run: (get) => fetch(`${versionedApiBaseUrl(base(get, 'GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com'), 'v1beta')}/models?pageSize=1`, {
    signal: t(), headers: { 'x-goog-api-key': get('GEMINI_API_KEY') },
  }),
};

const mistralMediaProbe: ProbeDef = {
  needs: [['LLM_MISTRAL_API_KEY']],
  run: (get) => fetch(`${versionedApiBaseUrl(base(get, 'LLM_MISTRAL_BASE_URL', 'https://api.mistral.ai/v1'), 'v1')}/models`, {
    signal: t(), headers: bearer(get('LLM_MISTRAL_API_KEY')),
  }),
};

const deepgramProbe: ProbeDef = {
  needs: [['DEEPGRAM_API_KEY']],
  run: (get) => fetch('https://api.deepgram.com/v1/projects', {
    signal: t(), headers: { Authorization: `Token ${get('DEEPGRAM_API_KEY')}` },
  }),
};

const groqProbe: ProbeDef = {
  needs: [['GROQ_API_KEY']],
  run: (get) => fetch(`${base(get, 'GROQ_BASE_URL', 'https://api.groq.com/openai/v1')}/models`, {
    signal: t(), headers: bearer(get('GROQ_API_KEY')),
  }),
};

/** xAI media pages: one probe for image and video; the subscription session
 * token takes priority over the configured LLM API key. */
const xaiMediaProbe: ProbeDef = {
  needs: [['LLM_XAI_OAUTH_API_KEY'], ['LLM_XAI_API_KEY']],
  run: (get) => {
    const token = xaiOauthAccessToken() || get('LLM_XAI_API_KEY');
    return fetchWithProxy(`${base(get, 'LLM_XAI_BASE_URL', 'https://api.x.ai/v1')}/models`, {
      signal: t(), headers: token ? bearer(token) : {},
    });
  },
  models: parseModelCatalog,
};

const elevenLabsProbe: ProbeDef = {
  needs: [['ELEVENLABS_API_KEY']],
  run: (get) => fetch(`${base(get, 'ELEVENLABS_BASE_URL', 'https://api.elevenlabs.io')}/v1/models`, {
    signal: t(), headers: { 'xi-api-key': get('ELEVENLABS_API_KEY') },
  }),
};

const cartesiaProbe: ProbeDef = {
  needs: [['CARTESIA_API_KEY']],
  run: (get) => fetch('https://api.cartesia.ai/voices?limit=1', {
    signal: t(),
    headers: {
      Authorization: `Bearer ${get('CARTESIA_API_KEY')}`,
      'Cartesia-Version': '2026-03-01',
    },
  }),
};


/** page key (same name as the vendor page key of settingsSchema) → detection definition.*/
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
  'image/gemini': geminiMediaProbe,
  'image/minimax': minimaxProbe,
  'image/byteplus': byteplusProbe,
  'image/xai': xaiMediaProbe,
  'image/wavespeed': {
    needs: [['WAVESPEED_API_KEY']],
    run: (get) => fetch(`${base(get, 'WAVESPEED_BASE_URL', 'https://api.wavespeed.ai')}/api/v3/balance`, {
      signal: t(), headers: bearer(get('WAVESPEED_API_KEY')),
    }),
  },
  'voice/elevenlabs': elevenLabsProbe,
  'voice/openai': openAiMediaProbe,
  'voice/gemini': geminiMediaProbe,
  'voice/mistral': mistralMediaProbe,
  'voice/cartesia': cartesiaProbe,
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
        req_params: { text: '测', speaker: 'zh_female_vv_uranus_bigtts', audio_params: { format: 'mp3', sample_rate: 24_000 } },
      }),
    }),
  },
  'voice/minimax': minimaxProbe,
  'voice/inworld': {
    needs: [['INWORLD_TTS_API_KEY']],
    run: (get) => fetch(`${base(get, 'INWORLD_TTS_BASE_URL', 'https://api.inworld.ai')}/voices/v1/voices`, {
      signal: t(), headers: { Authorization: `Basic ${get('INWORLD_TTS_API_KEY')}` },
    }),
  },
  'voice/fishaudio': {
    needs: [['FISHAUDIO_TTS_API_KEY']],
    run: (get) => fetch(`${base(get, 'FISHAUDIO_TTS_BASE_URL', 'https://api.fish.audio')}/model`, {
      signal: t(), headers: bearer(get('FISHAUDIO_TTS_API_KEY')),
    }),
  },
  // No free read-only endpoint is documented; synthesizing 1 word is the minimum real verification (negligible cost).
  'voice/speechify': {
    needs: [['SPEECHIFY_TTS_API_KEY']],
    run: (get) => fetch(`${base(get, 'SPEECHIFY_TTS_BASE_URL', 'https://api.sws.speechify.com')}/v1/audio/speech`, {
      method: 'POST', signal: t(),
      headers: { 'Content-Type': 'application/json', ...bearer(get('SPEECHIFY_TTS_API_KEY')) },
      body: JSON.stringify({ input: '测', voice_id: 'george', audio_format: 'mp3', model: get('SPEECHIFY_TTS_MODEL') || 'simba-multilingual' }),
    }),
  },
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
  'video/byteplus': byteplusProbe,
  'video/xai': xaiMediaProbe,
  'video/ofox': {
    needs: [['LLM_OFOX_API_KEY']],
    run: (get) => fetch(`${base(get, 'LLM_OFOX_BASE_URL', 'https://api.ofox.ai/v1')}/models`, {
      signal: t(), headers: bearer(get('LLM_OFOX_API_KEY')),
    }),
    models: parseModelCatalog,
  },
  'music/mureka': {
    needs: [['MUREKA_API_KEY']],
    run: (get) => fetch(`${base(get, 'MUREKA_BASE_URL', 'https://api.mureka.ai')}/v1/account/billing`, {
      signal: t(), headers: bearer(get('MUREKA_API_KEY')),
    }),
  },
  'music/minimax': minimaxProbe,
  'music/atlas': atlasMusicProbe,
  // Read-only account endpoint; fake key → 401. The same key also serves
  // /generate/sound (video-to-SFX), so one probe covers both capabilities.
  'music/sonilo': {
    needs: [['SONILO_API_KEY']],
    run: (get) => fetch(`${base(get, 'SONILO_BASE_URL', 'https://api.sonilo.com')}/v1/account/services`, {
      signal: t(), headers: bearer(get('SONILO_API_KEY')),
    }),
  },
  // /v1/search has been opened to anonymous users (the measured number is 200 without key), and the key; collections cannot be detected
  // It is the account binding endpoint, and the fake key is stable 401.
  'stock/pexels': {
    needs: [['PEXELS_API_KEY']],
    run: (get) => fetch('https://api.pexels.com/v1/collections?per_page=1', {
      signal: t(), headers: { Authorization: get('PEXELS_API_KEY') },
    }),
  },
  // Pixabay official design: key takes the query parameter (the server is directly connected to HTTPS, the same shape as the stock plugin).
  'stock/pixabay': {
    needs: [['PIXABAY_API_KEY']],
    run: (get) => {
      const params = new URLSearchParams({ key: get('PIXABAY_API_KEY'), q: 'sky', per_page: '3' });
      return fetchWithProxy(`https://pixabay.com/api/?${params.toString()}`, { signal: t() });
    },
  },
  // Unsplash: The search endpoint requires Client-ID, fake key 401.
  'stock/unsplash': {
    needs: [['UNSPLASH_ACCESS_KEY']],
    run: (get) => fetch('https://api.unsplash.com/search/photos?query=sky&per_page=1', {
      signal: t(), headers: { Authorization: 'Client-ID ' + get('UNSPLASH_ACCESS_KEY') },
    }),
  },
  // Freesound: token uses query (same shape as stock plugin), false token 401.
  'stock/freesound': {
    needs: [['FREESOUND_API_KEY']],
    run: (get) => {
      const params = new URLSearchParams({ query: 'wind', page_size: '1', fields: 'id', token: get('FREESOUND_API_KEY') });
      return fetchWithProxy('https://freesound.org/apiv2/search/text/?' + params.toString(), { signal: t() });
    },
  },
  'transcription/assemblyai': {
    needs: [['ASSEMBLYAI_API_KEY']],
    run: (get) => fetch('https://api.assemblyai.com/v2/transcript?limit=1', {
      signal: t(), headers: { authorization: get('ASSEMBLYAI_API_KEY') },
    }),
  },
  'transcription/openai': openAiMediaProbe,
  'transcription/mistral': mistralMediaProbe,
  'transcription/deepgram': deepgramProbe,
  'transcription/groq': groqProbe,
  'transcription/elevenlabs': elevenLabsProbe,
  'transcription/cartesia': cartesiaProbe,
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
  // S3 HeadBucket is sent via SDK (SigV4 signature cannot be fetched manually), r2.ts synthesizes Response:
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

/** Temporarily stored overrides (in the whitelist, the empty string represents clearing for this test) overwrite the stored value.*/
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

/** Run a connectivity probe of the provider's page. Unconfigured/unknown pages are returned before sending a request and do not hit the network.*/
export async function runProbe(page: string, overrides: Record<string, unknown>): Promise<ProbeResult> {
  if (page === 'agent/proxy') return runProxyProbe(overrides);
  // The storage root is not a keystore key (makeGetter would drop it), so its
  // writability check reads the panel's raw value directly.
  if (page === 'storage/projects') return runDataDirProbe(overrides);
  const probe = PROBES[page];
  if (!probe) return { ok: false, message: '该厂商暂不支持连接测试' };
  const get = makeGetter(overrides);
  const ready = probe.needs.some((group) => group.every((n) => get(n).length > 0));
  if (!ready) return { ok: false, message: '尚未填写 API Key · 填好后再点测试' };
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
        ? models.length > 0 ? ` · 已读取 ${models.length} 个模型` : ' · 接口未返回模型列表'
        : '';
      const okText = probe.okText?.(bodyText) ?? '连接成功 · 鉴权通过';
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
