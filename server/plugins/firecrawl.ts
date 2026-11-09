// Firecrawl plugin entry point: binds each /api/firecrawl/* route to its
// handler and turns a thrown error into the configured/ok/error envelope the
// client expects. Transport helpers live in firecrawl-shared.ts and the
// handlers in firecrawl-scrape.ts / firecrawl-crawl.ts; the exports callers
// already import from this module are re-exported below.

import type { Plugin } from 'vite';
import { parallelWebRequest } from './parallel-search.ts';
import { keenableWebRequest } from './keenable-search.ts';
import type { FirecrawlPluginOptions } from './firecrawl-shared.ts';
import { notConfigured, readJsonBody, sendJson } from './firecrawl-shared.ts';
import {
  handleScrape, handleSearch, handleMap,
} from './firecrawl-scrape.ts';
import {
  handleCrawl, handleBatchScrape,
} from './firecrawl-crawl.ts';

export type { FirecrawlPluginOptions } from './firecrawl-shared.ts';
export { buildActions, saveScreenshot, wrapExecJs } from './firecrawl-shared.ts';

export function firecrawlPlugin(options: FirecrawlPluginOptions): Plugin {
  return {
    name: 'openchatcut-firecrawl',
    configureServer(server) {
      const log = (m: string) => server.config.logger.info(m);
      const key = options.apiKey;
      // Parallel and Keenable are opt-in: only the user's WEB_SEARCH_PROVIDER
      // setting enables them, so neither an unconfigured install nor a tool
      // call sends queries there.
      const providerFor = (body: Record<string, unknown>): string => {
        const setting = options.searchProvider;
        if (setting === 'disabled') throw new Error('Web search and page reading are disabled.');
        if (setting && setting !== 'parallel' && setting !== 'keenable' && setting !== 'firecrawl') {
          throw new Error('WEB_SEARCH_PROVIDER must be parallel, keenable, firecrawl or disabled.');
        }
        const requested = body.provider;
        if (requested !== undefined && requested !== 'parallel' && requested !== 'keenable' && requested !== 'firecrawl') {
          throw new Error('provider must be parallel, keenable or firecrawl.');
        }
        if (requested === 'parallel' && setting !== 'parallel') {
          throw new Error('Parallel is not enabled. The user can set WEB_SEARCH_PROVIDER=parallel to use it.');
        }
        if (requested === 'keenable' && setting !== 'keenable') {
          throw new Error('Keenable is not enabled. The user can set WEB_SEARCH_PROVIDER=keenable to use it.');
        }
        return String(requested || setting || 'firecrawl');
      };
      const parallel = async (
        res: import('node:http').ServerResponse,
        operation: 'search' | 'fetch',
        body: Record<string, unknown>,
      ) => {
        const abort = new AbortController();
        const cancel = () => { if (!res.writableEnded) abort.abort(); };
        res.on('close', cancel);
        const timeoutMs = operation === 'fetch' && typeof body.timeout === 'number' && Number.isFinite(body.timeout)
          ? Math.max(1, Math.min(60_000, Math.round(body.timeout))) : 45_000;
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]);
        try {
          sendJson(res, 200, await parallelWebRequest(operation, body, signal));
        } finally {
          res.off('close', cancel);
        }
      };
      const keenable = async (
        res: import('node:http').ServerResponse,
        operation: 'search' | 'fetch',
        body: Record<string, unknown>,
      ) => {
        const abort = new AbortController();
        const cancel = () => { if (!res.writableEnded) abort.abort(); };
        res.on('close', cancel);
        const timeoutMs = operation === 'fetch' && typeof body.timeout === 'number' && Number.isFinite(body.timeout)
          ? Math.max(1, Math.min(60_000, Math.round(body.timeout))) : 45_000;
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]);
        try {
          sendJson(res, 200, await keenableWebRequest(operation, body, signal, options.keenableApiKey));
        } finally {
          res.off('close', cancel);
        }
      };

      server.middlewares.use('/api/web-browser', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed — use POST' });
          return;
        }
        try {
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          const provider = providerFor(body);
          if (provider === 'parallel') return await parallel(res, 'fetch', body);
          if (provider === 'keenable') return await keenable(res, 'fetch', body);
          if (notConfigured(res, options.apiKey)) return;
          await handleScrape(options.apiKey, body, res, log);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[web-browser] ${message}`);
          sendJson(res, 200, { configured: true, ok: false, error: message });
        }
      });

      server.middlewares.use('/api/firecrawl/search', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed — use POST' });
          return;
        }
        try {
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          const provider = providerFor(body);
          if (provider === 'parallel') return await parallel(res, 'search', body);
          if (provider === 'keenable') return await keenable(res, 'search', body);
          if (notConfigured(res, options.apiKey)) return;
          await handleSearch(options.apiKey, body, res);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[firecrawl/search] ${message}`);
          sendJson(res, 200, { configured: true, ok: false, error: message });
        }
      });

      server.middlewares.use('/api/firecrawl/map', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed — use POST' });
          return;
        }
        try {
          if (notConfigured(res, key)) return;
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          await handleMap(key, body, res);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[firecrawl/map] ${message}`);
          sendJson(res, 200, { configured: true, ok: false, error: message });
        }
      });

      server.middlewares.use('/api/firecrawl/crawl', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed — use POST' });
          return;
        }
        try {
          if (notConfigured(res, key)) return;
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          await handleCrawl(key, body, res, log);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[firecrawl/crawl] ${message}`);
          sendJson(res, 200, { configured: true, ok: false, error: message });
        }
      });

      server.middlewares.use('/api/firecrawl/batch', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed — use POST' });
          return;
        }
        try {
          if (notConfigured(res, key)) return;
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          await handleBatchScrape(key, body, res, log);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[firecrawl/batch] ${message}`);
          sendJson(res, 200, { configured: true, ok: false, error: message });
        }
      });
    },
  };
}
