// Firecrawl plugin entry point: binds each /api/firecrawl/* route to its
// handler and turns a thrown error into the configured/ok/error envelope the
// client expects. Transport helpers live in firecrawl-shared.ts and the
// handlers in firecrawl-scrape.ts / firecrawl-crawl.ts; the exports callers
// already import from this module are re-exported below.

import type { Plugin } from 'vite';
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

      server.middlewares.use('/api/web-browser', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed — use POST' });
          return;
        }
        try {
          if (notConfigured(res, key)) return;
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          await handleScrape(key, body, res, log);
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
          if (notConfigured(res, key)) return;
          const body = (await readJsonBody(req)) as Record<string, unknown>;
          await handleSearch(key, body, res);
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
