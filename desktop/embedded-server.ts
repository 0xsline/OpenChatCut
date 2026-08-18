// Electron embedded production server: a 127.0.0.1 HTTP server provides the same full stack as dev —
// ① seedKeystore(.env.local, cwd semantics are consistent with dev; the packaged version is main first chdir userData)
// ② /llm is mounted by the shared server plugin, /assemblyai injects the key here
// ③ Zero modification and mounting of server plugin (the measured dependency is only middlewares.use + config.logger)
// ④ /media/uploads Direct reading of assets at runtime + dist/ static cover (desktop/static-files.ts)
// The key still only lives in this process; the rendering process (BrowserWindow) only sees the same-origin HTTP API.
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import type { ViteDevServer } from 'vite';
import { serverPlugins } from '../server/plugins/index.ts';
import { getKey, seedKeystore } from '../server/keystore.ts';
import { trustedEditorRequest } from '../server/editor-auth.ts';
import { proxyMiddleware, type ProxyRoute } from '../server/proxy.ts';
import { parseEnvText } from './env-file.ts';
import { createMiniConnect, type MiniConnect } from './mini-connect.ts';
import { listenWithAffinity } from './embedded-port.ts';
import { distStaticMiddleware, uploadsMiddleware } from './static-files.ts';

export interface EmbeddedServer {
  server: Server;
  port: number;
  origin: string;
}

async function seedFromEnvLocal(): Promise<void> {
  const text = await readFile(resolve(process.cwd(), '.env.local'), 'utf8').catch(() => '');
  seedKeystore(parseEnvText(text));
}

function assemblyHeaders(): Record<string, string> {
  const k = getKey('ASSEMBLYAI_API_KEY');
  return k ? { authorization: k } : {};
}

function assemblyAiProxyAuthorized(req: IncomingMessage): boolean {
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  const method = req.method?.toUpperCase();
  const isRead = method === 'GET' || method === 'HEAD';
  return trustedEditorRequest(req, !isRead);
}

export function authorizeAssemblyAiProxy(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void {
  if (assemblyAiProxyAuthorized(req)) {
    next();
    return;
  }
  req.resume();
  res.writeHead(403, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ error: 'untrusted editor request' }));
}

export function mountAssemblyAiProxy(
  app: Pick<MiniConnect, 'use'>,
  route: ProxyRoute = {
    target: () => 'https://api.assemblyai.com',
    headers: assemblyHeaders,
  },
): void {
  app.use('/assemblyai', authorizeAssemblyAiProxy);
  app.use('/assemblyai', proxyMiddleware(route));
}

export async function startEmbeddedServer(distDir: string): Promise<EmbeddedServer> {
  await seedFromEnvLocal();

  const app = createMiniConnect((err) => {
    console.error('[embedded-server]', err instanceof Error ? err.message : err);
  });
  const server = createServer((req, res) => app.handle(req, res));

  // Authorize the renderer request before the proxy can inject the provider key.
  mountAssemblyAiProxy(app);

  // vite server pile: complete set of plugin dependencies = middlewares.use + config.logger (verified by plugin)
  const fake = {
    middlewares: { use: app.use.bind(app) },
    httpServer: server,
    config: {
      logger: {
        info: (msg: string) => console.log(msg),
        warn: (msg: string) => console.warn(msg),
        error: (msg: string) => console.error(msg),
      },
    },
  } as unknown as ViteDevServer;
  for (const plugin of serverPlugins({ projectStoreHttp: false })) {
    const hook = plugin.configureServer;
    const fn = typeof hook === 'function' ? hook : hook?.handler;
    await fn?.call(plugin as never, fake);
  }

  // Static cover at the end: uploading assets at runtime takes precedence over dist's build-stage copy
  app.use('/media/uploads', uploadsMiddleware());
  app.use(distStaticMiddleware(distDir));

  // Port policy: canonical 5199 first (the documented external-MCP address),
  // then the fallback used last time it was busy, then a fresh random port that
  // becomes the remembered one. See listenWithAffinity for why the fallback has
  // to be stable: a random port per launch silently broke registered agents.
  const port = await listenWithAffinity(server);
  return { server, port, origin: `http://127.0.0.1:${port}` };
}
