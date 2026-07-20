// 内嵌 server 的密钥注入代理:沿用 vite.config.ts 里 /llm 与 /assemblyai 两条
// server.proxy 的语义(changeOrigin + 服务端注入密钥 + 非 JSON/SSE 的 Content-Type
// 强改)。密钥只在这一侧进出站头,永不回落响应体。node http(s).request 不吃环境代理
// 变量,与 dev 下 http-proxy 的直连行为一致(Clash 环境不受影响)。
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Middleware } from './mini-connect.ts';

const HOP_BY_HOP = new Set(['host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

export interface ProxyRoute {
  /** 每请求取目标 base URL(keystore 即时值)。 */
  target: () => string;
  /** 每请求注入的出站头(密钥在此)。 */
  headers: () => Record<string, string>;
  /** 中转站兼容:非 application/json 且非 SSE 的响应强改为 JSON(SDK 才解析)。 */
  forceJsonContentType?: boolean;
}

export function proxyMiddleware(route: ProxyRoute): Middleware {
  return (req, res) => {
    let target: URL;
    try {
      target = new URL(route.target());
    } catch {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'proxy target is not a valid URL' }));
      return;
    }
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) headers[k] = v;
    }
    headers.host = target.host;  // changeOrigin
    for (const [k, v] of Object.entries(route.headers())) if (v) headers[k] = v;

    const basePath = target.pathname.replace(/\/$/, '');
    const doRequest = target.protocol === 'http:' ? httpRequest : httpsRequest;
    const upstream = doRequest({
      host: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      method: req.method,
      path: basePath + (req.url ?? '/'),
      headers,
    }, (upRes) => {
      const outHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) outHeaders[k] = v;
      }
      if (route.forceJsonContentType) {
        const ct = String(outHeaders['content-type'] ?? '');
        if (!ct.includes('application/json') && !ct.includes('text/event-stream')) {
          outHeaders['content-type'] = 'application/json';
        }
      }
      res.writeHead(upRes.statusCode ?? 502, outHeaders);
      upRes.pipe(res);
    });

    upstream.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `upstream request failed: ${err.message}` }));
      } else if (!res.writableEnded) {
        res.end();
      }
    });
    res.on('close', () => upstream.destroy());  // 客户端断开(中止流式回答)→ 断上游
    req.pipe(upstream);
  };
}
