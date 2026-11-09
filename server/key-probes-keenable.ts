// Keenable "Test connection" probe, split out of key-probes.ts to stay under the
// 500-line source ceiling. Keenable needs no account: the public search endpoint
// answers with only the app-identifier header, so the test passes with no key.
// An optional KEENABLE_API_KEY switches to the authenticated path and only lifts
// the anonymous rate limits.
import { proxyDispatcher } from './outbound-proxy.ts';
import { PROBE_TIMEOUT_MS } from './key-probe-local.ts';

type Get = (name: 'KEENABLE_API_KEY') => string;

export const keenableProbe = {
  needs: [[]] as readonly (readonly 'KEENABLE_API_KEY'[])[],
  run: (get: Get): Promise<Response> => {
    const key = get('KEENABLE_API_KEY');
    return fetch(`https://api.keenable.ai/v1/search${key ? '' : '/public'}`, {
      method: 'POST',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      dispatcher: proxyDispatcher(),
      headers: {
        'X-Keenable-Title': 'OpenChatCut',
        'Content-Type': 'application/json',
        ...(key ? { 'X-API-Key': key } : {}),
      },
      body: JSON.stringify({ query: 'OpenChatCut connection test', max_results: 1 }),
    } as RequestInit);
  },
  okText: () => '连接成功 · 搜索可用',
};
