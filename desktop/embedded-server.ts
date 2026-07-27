// Electron 内嵌生产 server:一台 127.0.0.1 HTTP server 提供与 dev 相同的全栈——
//   ① seedKeystore(.env.local,cwd 语义与 dev 一致;打包版由 main 先 chdir userData)
//   ② /llm 由共享 server 插件挂载，/assemblyai 在此注入密钥
//   ③ server 插件零改造挂载(实测依赖面仅 middlewares.use + config.logger)
//   ④ /media/uploads 运行时素材直读 + dist/ 静态兜底(desktop/static-files.ts)
// 密钥仍只活在这一进程;渲染进程(BrowserWindow)只见同源 HTTP API。
import { readFile } from 'node:fs/promises';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { resolve } from 'node:path';
import type { ViteDevServer } from 'vite';
import { serverPlugins } from '../server/plugins/index.ts';
import { seedKeystore } from '../server/keystore.ts';
import { pickKey, markRateLimited, shouldFailover } from '../server/key-rotation.ts';
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

// Per-request stash of the rotation index picked for AssemblyAI, keyed by the
// request object so onUpstreamStatus can mark the exact key that was used.
const assemblyRotIdx = new WeakMap<IncomingMessage, number>();

function assemblyHeaders(req: IncomingMessage): Record<string, string> {
  const picked = pickKey('ASSEMBLYAI');
  if (!picked) return {};
  assemblyRotIdx.set(req, picked.index);
  return { authorization: picked.key };
}

export async function startEmbeddedServer(distDir: string): Promise<EmbeddedServer> {
  await seedFromEnvLocal();

  const app = createMiniConnect((err) => {
    console.error('[embedded-server]', err instanceof Error ? err.message : err);
  });
  const server = createServer((req, res) => app.handle(req, res));

  // 代理在前(路径不与插件冲突,靠前少走几次匹配)
  app.use('/assemblyai', proxyMiddleware({
    target: () => 'https://api.assemblyai.com',
    headers: assemblyHeaders,
    onUpstreamStatus: (req, status) => {
      const idx = assemblyRotIdx.get(req);
      if (idx != null && shouldFailover('ASSEMBLYAI', status)) {
        markRateLimited('ASSEMBLYAI', idx);
      }
    },
  }));

  // vite server 桩:插件依赖面全集 = middlewares.use + config.logger(已逐插件核实)
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

  // 静态兜底在最后:运行时上传素材优先于 dist 的 build 期拷贝
  app.use('/media/uploads', uploadsMiddleware());
  app.use(distStaticMiddleware(distDir));

  // 端口策略:优先 CC_PORT env 或 5199(README 里外部 MCP 客户端的文档地址);被占(网页 dev
  // server / 第二个桌面实例)时回退随机端口——App 必须能起,MCP 客户端改用启动
  // 日志里的实际端口。其余 listen 错误照旧抛出。
  const preferredPort = Number(process.env.CC_PORT) || 5199;
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
  const port = await listenOn(preferredPort).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE') throw err;
    console.warn(`[embedded-server] port ${preferredPort} in use — falling back to a random port; point external MCP clients at the origin logged below`);
    return listenOn(0);
  });
  return { server, port, origin: `http://127.0.0.1:${port}` };
}
