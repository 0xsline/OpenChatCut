// Electron 内嵌生产 server:一台 127.0.0.1 HTTP server 提供与 dev 相同的全栈——
//   ① seedKeystore(.env.local,cwd 语义与 dev 一致;打包版由 main 先 chdir userData)
//   ② /llm、/assemblyai 密钥注入代理(desktop/proxy.ts)
//   ③ 13 个 server 插件零改造挂载(实测依赖面仅 middlewares.use + config.logger)
//   ④ /media/uploads 运行时素材直读 + dist/ 静态兜底(desktop/static-files.ts)
// 密钥仍只活在这一进程;渲染进程(BrowserWindow)只见同源 HTTP API。
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import type { ViteDevServer } from 'vite';
import { serverPlugins } from '../server/plugins/index.ts';
import { getKey, seedKeystore } from '../server/keystore.ts';
import { parseEnvText } from './env-file.ts';
import { createMiniConnect } from './mini-connect.ts';
import { proxyMiddleware } from './proxy.ts';
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

function llmHeaders(): Record<string, string> {
  const k = getKey('LLM_API_KEY');
  if (!k) return {};
  // 与 dev 代理完全一致:原生 Anthropic 头 + 兼容服务可能需要的 Bearer
  return { 'x-api-key': k, 'anthropic-version': '2023-06-01', authorization: `Bearer ${k}` };
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

  // 代理在前(路径不与插件冲突,靠前少走几次匹配)
  app.use('/llm', proxyMiddleware({
    target: () => getKey('LLM_BASE_URL') || 'https://api.anthropic.com',
    headers: llmHeaders,
    forceJsonContentType: true,
  }));
  app.use('/assemblyai', proxyMiddleware({
    target: () => 'https://api.assemblyai.com',
    headers: assemblyHeaders,
  }));

  // vite server 桩:插件依赖面全集 = middlewares.use + config.logger(已逐插件核实)
  const fake = {
    middlewares: { use: app.use.bind(app) },
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

  // 静态兜底在最后:运行时上传素材优先于 dist 的 build 期拷贝
  app.use('/media/uploads', uploadsMiddleware());
  app.use(distStaticMiddleware(distDir));

  const server = createServer((req, res) => app.handle(req, res));
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
