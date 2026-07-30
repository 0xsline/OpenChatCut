// 极简 connect:实现与 vite server.middlewares 一致的前缀路由语义,让 13 个 server 插件
// 在 Electron 内嵌 server 里零改造挂载。语义要点(插件代码依赖,勿动):
//   - use(route, fn):路径整段前缀匹配(/export 命中 /export/job,不命中 /exportx);
//   - 命中时 req.url 去掉前缀(空则 '/',query 保留),originalUrl 保原值;
//   - 链推进只靠显式 next()——处理器不调 next 即链止(异步处理器返回也不自动推进,
//     否则 serveDiskFile 这类"promise 先归、pipe 后完"的处理器会被二次分发踩坏);
//   - 处理器抛错/拒绝 → 未发头时兜 500。
import type { IncomingMessage, ServerResponse } from 'node:http';

export type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => unknown;

interface Layer { route: string; fn: Middleware; }

export interface MiniConnect {
  use(routeOrFn: string | Middleware, fn?: Middleware): void;
  handle(req: IncomingMessage, res: ServerResponse): void;
}

/** route 是否命中 path(整段前缀)。返回去前缀后的 path(未命中 null)。 */
export function matchRoute(route: string, path: string): string | null {
  if (route === '/' || route === '') return path;
  if (path === route) return '/';
  if (path.startsWith(route + '/')) return path.slice(route.length);
  return null;
}

/** 命中后的 req.url:去前缀 path + 原 query。 */
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
          return;  // 链止于当前处理器;推进只经它调 next()
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
