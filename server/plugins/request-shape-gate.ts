import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { projectStoreHttpAuthorized } from '../project-store-http-auth.ts';
import { externalMcpAuthorized } from '../editor-auth.ts';

/**
 * Whether a state-changing request may proceed under the local-device trust
 * model: loopback socket + loopback Host + same-origin Origin + browser
 * Sec-Fetch-Site (same-origin/none). The external MCP route additionally
 * accepts its exact editor token because non-browser clients omit Origin.
 */
export function requestShapeAllowed(req: IncomingMessage): boolean {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/external-mcp/mcp' && externalMcpAuthorized(req)) return true;
  // Upload slots carry a single-use, short-lived handoff token that the
  // /upload endpoint verifies itself (scope-bound filename/size/content-type);
  // external MCP clients upload without an Origin header, so the token is
  // their only credential and must pass the shape gate to reach that check.
  if (isHandoffUpload(req)) return true;
  return projectStoreHttpAuthorized(req);
}

function isHandoffUpload(req: IncomingMessage): boolean {
  const url = new URL(req.url ?? '/', 'http://localhost');
  return url.pathname === '/upload' && url.searchParams.has('handoff');
}

/** Global request-shape gate for every /api write mount (CSRF surface). */
export function requestShapeGatePlugin(): Plugin {
  return {
    name: 'openchatcut-request-shape-gate',
    configureServer(server) {
      // Cover every write mount, not only /api: /llm, /e2b, /generate,
      // /render-*, /export, /settings etc. are all CSRF-able via CORS
      // safelisted text/plain POSTs if left ungated.
      server.middlewares.use('/', (req: IncomingMessage, res: ServerResponse, next) => {
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
