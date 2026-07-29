// Minimal Connect-compatible router for mounting all server plugins unchanged in Electron.
// Semantics are dependency-sensitive:
// - use(route, fn) matches a complete path prefix: /export matches /export/job but not /exportx.
// - On a match, req.url drops the prefix (empty becomes "/") while preserving the query and originalUrl.
// - Only explicit next() advances the chain. A resolved async handler does not advance automatically,
//   preventing a second dispatch from overtaking handlers such as serveDiskFile that finish piping later.
// - A thrown or rejected handler returns 500 if headers have not been sent.
import type { IncomingMessage, ServerResponse } from 'node:http';

export type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => unknown;

interface Layer { route: string; fn: Middleware; }

export interface MiniConnect {
  use(routeOrFn: string | Middleware, fn?: Middleware): void;
  handle(req: IncomingMessage, res: ServerResponse): void;
}

/** Whether route hits path (whole prefix). Returns the prefixed path (misses null). */
export function matchRoute(route: string, path: string): string | null {
  if (route === '/' || route === '') return path;
  if (path === route) return '/';
  if (path.startsWith(route + '/')) return path.slice(route.length);
  return null;
}

/** Req.url after hit: remove the prefix path + original query. */
export function rewriteUrl(url: string, route: string): string | null {
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  const rest = matchRoute(route, path);
  if (rest === null) return null;
  return rest + (q === -1 ? '' : url.slice(q));
}

export function createMiniConnect(onError: (err: unknown) => void): MiniConnect {
  const stack: Layer[] = [];

  function fail(res: ServerResponse, err: unknown): void {
    onError(err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    } else if (!res.writableEnded) {
      res.end();
    }
  }

  return {
    use(routeOrFn, fn) {
      if (typeof routeOrFn === 'function') stack.push({ route: '/', fn: routeOrFn });
      else if (fn) stack.push({ route: routeOrFn, fn });
    },
    handle(req, res) {
      const reqAny = req as IncomingMessage & { originalUrl?: string };
      reqAny.originalUrl ??= req.url ?? '/';
      let i = 0;
      const step = (): void => {
        while (i < stack.length) {
          const layer = stack[i++];
          const rewritten = rewriteUrl(reqAny.originalUrl ?? '/', layer.route);
          if (rewritten === null) continue;
          req.url = rewritten;
          try {
            const out = layer.fn(req, res, step);
            if (out instanceof Promise) out.catch((err) => fail(res, err));
          } catch (err) {
            fail(res, err);
          }
          return;  // The chain ends at the current processor; advance only through it by calling next()
        }
        if (!res.headersSent) {
          res.statusCode = 404;
          res.end('not found');
        }
      };
      step();
    },
  };
}
