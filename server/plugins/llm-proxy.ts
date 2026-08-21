import type { IncomingMessage } from 'node:http';
import type { Plugin } from 'vite';
import { getKey, type KeyName } from '../keystore.ts';
import {
  normalizeLlmProvider,
  llmProviderPreset,
  protocolForProvider,
  type LlmProvider,
} from '../../shared/llm-providers.ts';
import { resolveLlmProviderConfig } from '../llm-config.ts';
import { xaiOauthAccessToken } from '../xai-oauth-session.ts';
import { proxyMiddleware } from '../proxy.ts';

function keyReader(name: string): string {
  return getKey(name as KeyName);
}

export function llmProviderForRequest(req?: IncomingMessage): LlmProvider {
  const requested = req?.headers['x-openchatcut-provider'];
  return normalizeLlmProvider(typeof requested === 'string' ? requested : getKey('LLM_PROVIDER'));
}

export function llmTarget(req?: IncomingMessage): string {
  return resolveLlmProviderConfig(llmProviderForRequest(req), keyReader).baseUrl;
}

export function llmHeaders(req?: IncomingMessage): Record<string, string> {
  const config = resolveLlmProviderConfig(llmProviderForRequest(req), keyReader);
  if (config.provider === 'xai-oauth') {
    // The subscription session token is refreshed server-side; fall back to a
    // manually configured key in the same slot for API-key-only accounts.
    const sessionToken = xaiOauthAccessToken();
    const token = sessionToken || config.apiKey;
    return token ? { authorization: `Bearer ${token}` } : {};
  }
  if (!config.apiKey) return {};
  const protocol = protocolForProvider(config.provider);
  if (protocol === 'anthropic') return { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' };
  if (protocol === 'google') return { 'x-goog-api-key': config.apiKey };
  return { authorization: `Bearer ${config.apiKey}` };
}

export function llmErrorMessage(status: number, req?: IncomingMessage): string {
  const provider = llmProviderForRequest(req);
  const label = llmProviderPreset(provider).label;
  if (provider === 'xai-oauth' && (status === 401 || status === 403)) {
    return status === 403
      ? 'xAI 拒绝了订阅会话的 API 访问（当前订阅档位可能未开放）。可升级订阅，或改在“设置 → Agent 模型 → xAI Grok”页配置 API Key 使用。'
      : 'xAI 订阅会话已失效。请在终端运行 grok login 重新登录，然后在“设置 → Agent 模型 → xAI Grok (订阅登录)”页点击导入。';
  }
  if (status === 401 || status === 403) {
    return `${label} 认证失败。请在“设置 → Agent 模型”中检查 API Key。`;
  }
  if (status === 402 || status === 429) {
    return `${label} 额度不足或请求过于频繁。请检查账户额度，稍后重试。`;
  }
  if (status === 404) {
    return `${label} 的接口或模型不存在。请检查 Base URL 和模型名称。`;
  }
  if (status >= 500) {
    return `${label} 服务暂时不可用（HTTP ${status}）。请稍后重试或切换模型。`;
  }
  return `${label} 请求失败（HTTP ${status}）。请检查“设置 → Agent 模型”中的连接配置。`;
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
        errorMessage: llmErrorMessage,
      }));
    },
  };
}
