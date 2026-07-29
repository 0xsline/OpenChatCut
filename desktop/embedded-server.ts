// Electron embedded production server: a 127.0.0.1 HTTP server provides the same full stack as dev —
// ① seedKeystore(.env.local, cwd semantics are consistent with dev; the packaged version is main first chdir userData)
// ② /llm is mounted by the shared server plugin, /assemblyai injects the key here
// ③ Zero modification and mounting of server plugin (the measured dependency is only middlewares.use + config.logger)
// ④ /media/uploads Direct reading of assets at runtime + dist/ static cover (desktop/static-files.ts)
// The key still only lives in this process; the rendering process (BrowserWindow) only sees the same-origin HTTP API.
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import type { ViteDevServer } from 'vite';
import { serverPlugins } from '../server/plugins/index.ts';
import { getKey, seedKeystore } from '../server/keystore.ts';
import { proxyMiddleware } from '../server/proxy.ts';
import { parseEnvText } from './env-file.ts';
import { createMiniConnect } from './mini-connect.ts';
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

export async function startEmbeddedServer(distDir: string): Promise<EmbeddedServer> {
  await seedFromEnvLocal();

  const app = createMiniConnect((err) => {
    console.error('[embedded-server]', err instanceof Error ? err.message : err);
  });
  const server = createServer((req, res) => app.handle(req, res));

  // The agent is in front (the path does not conflict with the plugin, so it will take less matching)
  app.use('/assemblyai', proxyMiddleware({
    target: () => 'https://api.assemblyai.com',
    headers: assemblyHeaders,
  }));

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
  for (const plugin of serverPlugins()) {
    const hook = plugin.configureServer;
    const fn = typeof hook === 'function' ? hook : hook?.handler;
    await fn?.call(plugin as never, fake);
  }

  // Static cover at the end: uploading assets at runtime takes precedence over dist's build-stage copy
  app.use('/media/uploads', uploadsMiddleware());
  app.use(distStaticMiddleware(distDir));

  // Port policy: priority 5199 (document address of external MCP client in README); occupied (web page dev
  // server / second desktop instance), fall back to a random port - the App must be able to start, and the MCP client is started instead.
  // The actual port in the log. Other listen errors are still thrown.
  const listenOn = (port: number) => new Promise<number>((resolvePort, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      const addr = server.address();
      if (addr && typeof addr === 'object') resolvePort(addr.port);
      else reject(new Error('embedded server failed to bind'));
    });
  });
  const port = await listenOn(5199).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE') throw err;
    console.warn('[embedded-server] port 5199 in use — falling back to a random port; point external MCP clients at the origin logged below');
    return listenOn(0);
  });
  return { server, port, origin: `http://127.0.0.1:${port}` };
}
