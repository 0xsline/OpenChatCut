// 设置面板「测试连接」的服务端探测表:每个厂商页一条最轻量的真实鉴权请求
// (只读端点或近零成本调用),验证 Key + Base URL 可用。密钥来自 keystore,
// 或请求体 overrides(面板里尚未保存的暂存值,仅本次探测生效、不落盘)。
// 安全不变式:结果只含 ok / message / status / latencyMs,永不回显任何密钥值;
// 厂商报错文案压平截断后才进 message。端点与鉴权头逐一对齐各 vite-plugin-* 的
// 真实调用写法(豆包三 header / MiniMax base_resp / Gemini x-goog-api-key…)。
import { getKey, KEY_NAMES, type KeyName } from './keystore.ts';
import { r2Probe } from './r2.ts';
import { mediaDirProbe, mediaDirPostCheck, mediaDirOkText } from './media-dir.ts';
import {
  AI_SDK_BASE_URL_FORMAT,
  llmOperationPath,
  normalizeServerLlmProvider,
  resolveLlmBaseUrl,
} from './llm-config.ts';
import {
  defaultModelForProvider,
  protocolForProvider,
} from '../shared/llm-providers.ts';

export interface ProbeResult {
  ok: boolean;
  message: string;
  status?: number;
  latencyMs?: number;
}

type Get = (name: KeyName) => string;

interface ProbeDef {
  /** 起测门槛:OR 的 AND 组(豆包 = App ID + Access Key 齐) */
  readonly needs: readonly (readonly KeyName[])[];
  readonly run: (get: Get) => Promise<Response>;
  /** 2xx 也可能是厂商级失败(MiniMax base_resp);返回错误文案,null = 真成功 */
  readonly postCheck?: (bodyText: string) => string | null;
  /** 成功时的自定义结论(本地磁盘探针等非网络检查);null/缺省 = 通用「连接成功」 */
  readonly okText?: (bodyText: string) => string | null;
}

const TIMEOUT_MS = 12_000;
const t = (): AbortSignal => AbortSignal.timeout(TIMEOUT_MS);
const base = (get: Get, name: KeyName, def: string): string => (get(name) || def).replace(/\/+$/, '');
const bearer = (key: string): Record<string, string> => ({ Authorization: `Bearer ${key}` });
function probeLlm(get: Get): Promise<Response> {
  const provider = normalizeServerLlmProvider(get('LLM_PROVIDER'));
  const protocol = protocolForProvider(provider);
  const root = resolveLlmBaseUrl(provider, get('LLM_BASE_URL'), get('LLM_BASE_URL_FORMAT'));
  const endpoint = `${root}${llmOperationPath(provider)}`;
  const key = get('LLM_API_KEY');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...bearer(key),
  };
  if (protocol === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    return fetch(endpoint, {
      method: 'POST', signal: t(), headers,
      body: JSON.stringify({
        model: get('LLM_MODEL') || defaultModelForProvider(provider),
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
  }
  if (protocol === 'openai') {
    return fetch(endpoint, {
      method: 'POST', signal: t(), headers,
      body: JSON.stringify({
        model: get('LLM_MODEL') || defaultModelForProvider(provider),
        max_output_tokens: 16,
        input: 'ping',
      }),
    });
  }
  return fetch(endpoint, {
    method: 'POST', signal: t(), headers,
    body: JSON.stringify({
      model: get('LLM_MODEL') || defaultModelForProvider(provider),
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  });
}

/** 厂商报错文案进结果前压平:去换行、截断。绝不拼接任何密钥值。 */
export function sanitize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 140);
}

/** MiniMax:HTTP 200 也可能鉴权失败,真相在 base_resp.status_code(0 = 成功)。 */
export function minimaxPostCheck(bodyText: string): string | null {
  try {
    const body = JSON.parse(bodyText) as { base_resp?: { status_code?: number; status_msg?: string } };
    const code = body.base_resp?.status_code ?? 0;
    if (code === 0) return null;
    const msg = body.base_resp?.status_msg ?? '';
    const hint = code === 1004 ? '（鉴权失败，检查 Key）' : '';
    return `MiniMax base_resp ${code}${msg ? ` · ${sanitize(msg)}` : ''}${hint}`;
  } catch {
    return null; // 非 JSON 的 2xx 按成功算
  }
}

// MiniMax 四个能力页共用一条探测:POST /v1/get_voice(免费只读;
// voice_cloning 列表通常为空,响应最小)。
const minimaxProbe: ProbeDef = {
  needs: [['MINIMAX_API_KEY']],
  run: (get) => fetch(`${base(get, 'MINIMAX_BASE_URL', 'https://api.minimaxi.com')}/v1/get_voice`, {
    method: 'POST', signal: t(),
    headers: { 'Content-Type': 'application/json', ...bearer(get('MINIMAX_API_KEY')) },
    body: JSON.stringify({ voice_type: 'voice_cloning' }),
  }),
  postCheck: minimaxPostCheck,
};

/** page key(与 settingsSchema 的厂商页 key 同名)→ 探测定义。 */
export const PROBES: Record<string, ProbeDef> = {
  // 按当前接口格式发真实最小生成请求；/v1/models 不能证明所选模型可用。
  'llm/anthropic': {
    needs: [['LLM_API_KEY']],
    run: probeLlm,
  },
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
  // openspeech 没有免费探测端点,合成 1 个字是最小真实验证(费用可忽略)。
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
  // /v1/search 已对匿名开放(实测无 key 也 200),验不出 key;collections
  // 是账户绑定端点,假 key 稳定 401。
  'stock/pexels': {
    needs: [['PEXELS_API_KEY']],
    run: (get) => fetch('https://api.pexels.com/v1/collections?per_page=1', {
      signal: t(), headers: { Authorization: get('PEXELS_API_KEY') },
    }),
  },
  // Pixabay 官方设计:key 走 query 参数(服务端直连 HTTPS,与 stock 插件同形)。
  'stock/pixabay': {
    needs: [['PIXABAY_API_KEY']],
    run: (get) => {
      const params = new URLSearchParams({ key: get('PIXABAY_API_KEY'), q: 'sky', per_page: '3' });
      return fetch(`https://pixabay.com/api/?${params.toString()}`, { signal: t() });
    },
  },
  // Unsplash:search 端点要求 Client-ID,假 key 401。
  'stock/unsplash': {
    needs: [['UNSPLASH_ACCESS_KEY']],
    run: (get) => fetch('https://api.unsplash.com/search/photos?query=sky&per_page=1', {
      signal: t(), headers: { Authorization: 'Client-ID ' + get('UNSPLASH_ACCESS_KEY') },
    }),
  },
  // Freesound:token 走 query(与 stock 插件同形),假 token 401。
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
  // S3 HeadBucket 经 SDK 发出(SigV4 签名没法手拼 fetch),r2.ts 合成 Response:
  // 200=桶在且鉴权过;403/404 走 classifyStatus;网络层原样抛给 networkMessage。
  'storage/r2': {
    needs: [['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']],
    run: (get) => r2Probe(get),
  },
  // 本地保存目录:磁盘检查(建目录 + 写删探测文件),非网络请求。空组 needs = 未填
  // 也可测(未设 = 用默认目录,本身就是合法状态)。
  'storage/local': {
    needs: [[]],
    run: (get) => mediaDirProbe(get),
    postCheck: mediaDirPostCheck,
    okText: mediaDirOkText,
  },
};

/** 非 2xx 状态 → 用户能读懂的结论(鉴权 / 地址 / 限流 / 其他)。 */
export function classifyStatus(status: number, bodyText: string): ProbeResult {
  if (status === 401 || status === 403) {
    return { ok: false, status, message: `鉴权失败（HTTP ${status}）· Key 无效、过期或无此接口权限` };
  }
  if (status === 404) {
    return { ok: false, status, message: '探测端点 404 · Base URL 可能填错（或该服务不认此探测路径）' };
  }
  if (status === 429) {
    return { ok: true, status, message: '鉴权通过（HTTP 429 限流，说明 Key 有效）' };
  }
  const detail = sanitize(bodyText);
  return { ok: false, status, message: `HTTP ${status}${detail ? ` · ${detail}` : ''}` };
}

/** 网络层失败(连不上 / 超时)≠ Key 错误,文案明确区分,并提示可能需要代理。 */
export function networkMessage(error: unknown): string {
  const raw = error instanceof Error
    ? `${error.name}: ${error.message}${error.cause instanceof Error ? `（${error.cause.message}）` : ''}`
    : String(error);
  // 注意:undici 自带 10s 连接超时,常先于我们 12s 的整体闸触发,不写死秒数。
  if (/timeout|abort/i.test(raw)) {
    return '连接超时 · 服务不可达或网络受限（可能需代理），不代表 Key 错误';
  }
  return `网络不可达 · ${sanitize(raw)} · 本机连不上该服务（可能需代理），不代表 Key 错误`;
}

/** 暂存 overrides(白名单内，空串代表本次测试清除)覆盖已存值。 */
export function makeGetter(overrides: Record<string, unknown>): Get {
  const clean = new Map<string, string>();
  for (const [name, raw] of Object.entries(overrides)) {
    if (!(KEY_NAMES as readonly string[]).includes(name)) continue; // 白名单外丢弃
    clean.set(name, String(raw ?? '').trim());
  }
  if (clean.has('LLM_BASE_URL') && !clean.has('LLM_BASE_URL_FORMAT')) {
    clean.set('LLM_BASE_URL_FORMAT', clean.get('LLM_BASE_URL') ? AI_SDK_BASE_URL_FORMAT : '');
  }
  return (name) => clean.has(name) ? clean.get(name)! : getKey(name);
}

/** 跑一个厂商页的连通性探测。未配置 / 未知页在发请求前就返回,不打网络。 */
export async function runProbe(page: string, overrides: Record<string, unknown>): Promise<ProbeResult> {
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
      const okText = probe.okText?.(bodyText) ?? '连接成功 · 鉴权通过';
      return { ok: true, status: response.status, latencyMs, message: `${okText} · ${latencyMs}ms` };
    }
    return { ...classifyStatus(response.status, bodyText), latencyMs };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, message: networkMessage(error) };
  }
}
