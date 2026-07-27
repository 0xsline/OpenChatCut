// Trending-news plugin: server-side proxy to Google News RSS (free, no API key).
// The browser cannot fetch news.google.com directly (CORS), so the agent's
// fetch_trending_topics tool POSTs here. We pull an Indonesia-locale RSS feed,
// parse the items, HTML-decode titles, and return structured JSON. No key needed —
// this only reads a public RSS feed, so it's safe to expose.
import type { Plugin } from 'vite';

interface NewsItem {
  title: string;
  link: string;
  source: string;
  pubDate: string;
  pubEpoch: number;
}

const DEFAULT_QUERY = 'geopolitik OR konflik OR perang OR diplomasi OR ekonomi global';
const TIMEOUT_MS = 12_000;

/** Decode the handful of HTML entities Google News puts in <title>. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .trim();
}

function parseRss(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const title = decodeEntities(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
    const link = (block.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? '').trim();
    const source = decodeEntities(block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] ?? '');
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? '').trim();
    if (!title) continue;
    items.push({
      title,
      link,
      source,
      pubDate,
      pubEpoch: Date.parse(pubDate) || 0,
    });
  }
  return items;
}

export function newsPlugin(): Plugin {
  return {
    name: 'openchatcut-news',
    configureServer(server) {
      server.middlewares.use('/api/news-trending', async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'POST required' }));
          return;
        }
        // read body
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.from(c as Buffer));
        let body: Record<string, unknown> = {};
        try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
        catch { /* empty body → defaults */ }

        const query = typeof body.query === 'string' && body.query.trim()
          ? body.query.trim()
          : DEFAULT_QUERY;
        const gl = typeof body.gl === 'string' && body.gl.trim() ? body.gl.trim() : 'ID';
        const hl = typeof body.hl === 'string' && body.hl.trim() ? body.hl.trim() : 'id';
        const limit = Math.max(1, Math.min(40, typeof body.limit === 'number' ? body.limit : 15));

        const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${gl}:${hl}`;
        try {
          const rssRes = await fetch(url, {
            headers: { 'user-agent': 'Mozilla/5.0 (OpenChatCut news proxy)' },
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (!rssRes.ok) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: `Google News RSS HTTP ${rssRes.status}` }));
            return;
          }
          const xml = await rssRes.text();
          const items = parseRss(xml)
            .sort((a, b) => b.pubEpoch - a.pubEpoch)
            .slice(0, limit);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, query, locale: `${gl}/${hl}`, count: items.length, asOf: new Date().toISOString(), items }));
        } catch (e) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            ok: false,
            error: `news fetch failed: ${e instanceof Error ? e.message : String(e)}`,
            hint: 'Google News RSS may be regionally blocked; fall back to web_search.',
          }));
        }
      });
    },
  };
}
