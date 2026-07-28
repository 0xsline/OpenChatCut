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
}

export function proxyMiddleware(route: ProxyRoute): Middleware {
  return (req, res) => {
    let target: URL;
    try {
      target = new URL(route.target(req));
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new Error('unsupported proxy protocol');
      }
    } catch {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'proxy target is not a valid URL' }));
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
      if (status >= 400 && route.errorMessage) {
        const errorMessage = route.errorMessage; // capture before the async closure (TS can't keep the narrow inside it)
        // Collect + log the REAL upstream error body so 4xx/5xx causes are diagnosable
        // (the generic errorMessage otherwise hides the provider's actual reason — e.g.
        // warungkeys/z.ai rejecting a tool schema or a param). Surface a short reason too.
        let upstreamBody = '';
        upRes.setEncoding('utf8');
        upRes.on('data', (chunk: string) => { upstreamBody += chunk; });
        upRes.on('end', () => {
          console.error(`[proxy ${status}] ${req.method} ${req.url} upstream=${route.target(req)} body=${upstreamBody.slice(0, 1200)}`);
          let reason = '';
          try {
            const parsed = JSON.parse(upstreamBody) as { error?: { message?: string }; message?: string };
            reason = parsed.error?.message ?? parsed.message ?? '';
          } catch { reason = upstreamBody.slice(0, 200); }
          res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: { message: errorMessage(status, req) + (reason ? ` — ${reason}` : '') } }));
        });
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

    upstream.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `upstream request failed: ${err.message}` }));
      } else if (!res.writableEnded) {
        res.end();
      }
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  };
}
