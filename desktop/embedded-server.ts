// Electron embedded production server: a 127.0.0.1 HTTP server provides the same full stack as dev -
//   ① seedKeystore(.env.local, cwd semantics are consistent with dev; the packaged version is main first chdir userData)
//   ② /llm is mounted by the shared server plug-in, /assemblyai injects the key here
//   ③ Zero modification and mounting of server plug-in (the measured dependency is only middlewares.use + config.logger)
//   ④ /media/uploads Direct reading of materials at runtime + dist/ static cover (desktop/static-files.ts)
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

  // The agent is first (the path does not conflict with the plug-in, and the first step is less matching)
  app.use('/assemblyai', proxyMiddleware({
    target: () => 'https://api.assemblyai.com',
    headers: assemblyHeaders,
  }));

  // vite server pile: complete set of plug-in dependencies = middlewares.use + config.logger (verified by plug-in)
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

  // Static security at the end: Uploading materials at runtime takes precedence over dist’s build-stage copy
  app.use('/media/uploads', uploadsMiddleware());
  app.use(distStaticMiddleware(distDir));

  const port = await new Promise<number>((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolvePort(addr.port);
      else reject(new Error('embedded server failed to bind'));
    });
  });
  return { server, port, origin: `http://127.0.0.1:${port}` };
}
