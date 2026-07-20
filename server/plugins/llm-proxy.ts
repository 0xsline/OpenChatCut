import type { Plugin } from 'vite';
import { getKey } from '../keystore.ts';
import { protocolForProvider } from '../../shared/llm-providers.ts';
import { resolveLlmBaseUrl } from '../llm-config.ts';
import { proxyMiddleware } from '../proxy.ts';

export function llmTarget(): string {
  return resolveLlmBaseUrl(
    getKey('LLM_PROVIDER'),
    getKey('LLM_BASE_URL'),
    getKey('LLM_BASE_URL_FORMAT'),
  );
}

export function llmHeaders(): Record<string, string> {
  const key = getKey('LLM_API_KEY');
  if (!key) return {};
  return protocolForProvider(getKey('LLM_PROVIDER')) === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${key}` };
}

/** One dynamic proxy implementation shared by Vite dev and Electron production. */
export function llmProxyPlugin(): Plugin {
  return {
    name: 'openchatcut-llm-proxy',
    configureServer(server) {
      server.middlewares.use('/llm', proxyMiddleware({
        target: llmTarget,
        headers: llmHeaders,
        forceJsonContentType: true,
      }));
    },
  };
}
