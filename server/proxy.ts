// Shared streaming proxy for Vite dev and the Electron embedded server.
// `target()` and `headers()` are evaluated for every request, so settings saved
// through the keystore take effect immediately without exposing keys to browser JS.
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => unknown;

const HOP_BY_HOP = new Set(['host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

export interface ProxyRoute {
  /** Target API prefix, evaluated per request. */
  target: (req: IncomingMessage) => string;
  /** Outbound headers, evaluated per request. */
  headers: (req: IncomingMessage) => Record<string, string>;
  /** Normalize generic relay responses so provider SDKs can parse JSON. */
  forceJsonContentType?: boolean;
  /** Replace upstream error bodies with one actionable message. */
  errorMessage?: (status: number, req: IncomingMessage) => string;
  /** Observability hook; must not receive request bodies or secret header values. */
  onTrace?: (event: 'start' | 'complete' | 'error', detail: { label?: string; requestId: string; method: string; path: string; status?: number; elapsedMs: number; error?: string; errorKind?: string }) => void;
  traceLabel?: (req: IncomingMessage) => string;
}

function proxyErrorKind(error: NodeJS.ErrnoException): string {
  if (error.code === 'EAI_AGAIN') return 'dns-temporary';
  if (error.code === 'ENOTFOUND') return 'dns-not-found';
  if (error.code === 'ETIMEDOUT') return 'connect-timeout';
  if (error.code === 'ECONNREFUSED') return 'connection-refused';
  if (error.code === 'ECONNRESET') return 'connection-reset';
  return 'upstream-network';
}

function requestIdFor(req: IncomingMessage): string {
  const incoming = req.headers['x-openchatcut-request-id'];
  return typeof incoming === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(incoming)
    ? incoming
    : `llm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function proxyMiddleware(route: ProxyRoute): Middleware {
  return (req, res) => {
    const startedAt = Date.now();
    const tracePath = (req.url ?? '/').split('?')[0];
    const traceLabel = route.traceLabel?.(req);
    const requestId = requestIdFor(req);
    let target: URL;
    try {
      target = new URL(route.target(req));
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new Error('unsupported proxy protocol');
      }
    } catch {
      res.writeHead(502, { 'Content-Type': 'application/json', 'x-openchatcut-request-id': requestId });
      res.end(JSON.stringify({ error: { message: 'proxy target is not a valid URL', requestId, kind: 'proxy-config', retryable: false } }));
      return;
    }
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase()) && k.toLowerCase() !== 'x-openchatcut-provider' && v !== undefined) {
        headers[k] = v;
      }
    }
    headers.host = target.host;
    for (const [k, v] of Object.entries(route.headers(req))) if (v) headers[k] = v;
    route.onTrace?.('start', { label: traceLabel, requestId, method: req.method ?? 'GET', path: tracePath, elapsedMs: 0 });

    const basePath = target.pathname.replace(/\/$/, '');
    const rawUrl = req.url ?? '/';
    const queryAt = rawUrl.indexOf('?');
    const requestPath = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
    const search = new URLSearchParams(target.search);
    if (queryAt !== -1) {
      for (const [name, value] of new URLSearchParams(rawUrl.slice(queryAt + 1))) {
        search.append(name, value);
      }
    }
    const query = search.size > 0 ? `?${search.toString()}` : '';
    const doRequest = target.protocol === 'http:' ? httpRequest : httpsRequest;
    const upstream = doRequest({
      host: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      method: req.method,
      path: basePath + requestPath + query,
      headers,
    }, (upRes) => {
      const status = upRes.statusCode ?? 502;
      route.onTrace?.('complete', { label: traceLabel, requestId, method: req.method ?? 'GET', path: tracePath, status, elapsedMs: Date.now() - startedAt });
      if (status >= 400 && route.errorMessage) {
        upRes.resume();
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'x-openchatcut-request-id': requestId });
        res.end(JSON.stringify({ error: { message: route.errorMessage(status, req), requestId, kind: 'upstream-http', retryable: status >= 500 || status === 429 } }));
        return;
      }
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
      res.writeHead(status, outHeaders);
      upRes.pipe(res);
    });

    upstream.on('error', (err: NodeJS.ErrnoException) => {
      const kind = proxyErrorKind(err);
      route.onTrace?.('error', { label: traceLabel, requestId, method: req.method ?? 'GET', path: tracePath, elapsedMs: Date.now() - startedAt, error: err.message, errorKind: kind });
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'x-openchatcut-request-id': requestId });
        res.end(JSON.stringify({ error: { message: `upstream ${kind} failure`, requestId, kind, retryable: true } }));
      } else if (!res.writableEnded) {
        res.end();
      }
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  };
}
