import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { projectStoreHttpAuthorized } from '../project-store-http-auth.ts';

function header(req: IncomingMessage, name: string): string | null {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : null;
}

/**
 * Whether a state-changing request may proceed under the local-device trust
 * model: loopback socket + loopback Host + same-origin Origin + browser
 * Sec-Fetch-Site (same-origin/none). External MCP clients authenticate with
 * a Bearer token instead (their endpoints verify it); a cross-site page
 * cannot attach custom Authorization headers without a CORS preflight that
 * this server never answers.
 */
export function requestShapeAllowed(req: IncomingMessage): boolean {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  const authorization = header(req, 'authorization') ?? '';
  if (authorization.startsWith('Bearer ')) return true;
  return projectStoreHttpAuthorized(req);
}

/** Global request-shape gate for every /api write mount (CSRF surface). */
export function requestShapeGatePlugin(): Plugin {
  return {
    name: 'openchatcut-request-shape-gate',
    configureServer(server) {
      server.middlewares.use('/api', (req: IncomingMessage, res: ServerResponse, next) => {
        if (requestShapeAllowed(req)) {
          next();
          return;
        }
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'invalid request origin' }));
      });
    },
  };
}
