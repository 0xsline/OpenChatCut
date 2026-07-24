// Minimalist connect: implements prefix routing semantics consistent with vite server.middlewares, allowing 13 server plug-ins
// Zero-modification mounting in Electron embedded server. Semantic points (plug-in code depends on it, don’t touch it):
//   - use(route, fn): match the entire path prefix (/export hits /export/job, does not hit /exportx);
//   - When hit, req.url removes the prefix (if empty, '/', query retains), and originalUrl retains its original value;
//   - Chain advancement only relies on explicit next() - if the processor does not adjust next, the chain will stop (the asynchronous processor will not automatically advance when it returns.
//     Otherwise, processors such as serveDiskFile that "return promise first and complete pipe later" will be trampled by secondary distribution);
//   - Processor throws error/rejection → 500 when not issued.
import type { IncomingMessage, ServerResponse } from 'node:http';

export type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => unknown;

interface Layer { route: string; fn: Middleware; }

export interface MiniConnect {
  use(routeOrFn: string | Middleware, fn?: Middleware): void;
  handle(req: IncomingMessage, res: ServerResponse): void;
}

/** route Is it a hit? path(whole prefix). Return the prefixed path(miss null)。 */
export function matchRoute(route: string, path: string): string | null {
  if (route === '/' || route === '') return path;
  if (path === route) return '/';
  if (path.startsWith(route + '/')) return path.slice(route.length);
  return null;
}

/** after hit req.url:remove prefix path + original query。 */
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
          return;  // The chain ends at the current processor; advancement is only through it calling next()
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
