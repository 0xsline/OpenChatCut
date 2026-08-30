// The two long-running Firecrawl jobs: whole-site crawl and batch scrape.
// Both submit work, poll for completion and slim the page list, which is what
// separates them from the single-shot endpoints in firecrawl-scrape.ts.

import type { ServerResponse } from 'node:http';
import type { SourceFormat } from './firecrawl-shared.ts';
import {
  FC_V2, fcError, fcFetch, isHttpUrl, mapFormats, sendJson, sleep, truncate,
} from './firecrawl-shared.ts';

export async function handleCrawl(
  apiKey: string,
  body: Record<string, unknown>,
  res: ServerResponse,
  log: (m: string) => void,
): Promise<void> {
  const url = String(body.url ?? '').trim();
  if (!url || !isHttpUrl(url)) {
    sendJson(res, 400, { error: 'url must be a valid http(s) URI' });
    return;
  }

  const limit = typeof body.limit === 'number'
    ? Math.max(1, Math.min(50, Math.round(body.limit)))
    : 10;
  const maxDiscoveryDepth = typeof body.maxDiscoveryDepth === 'number'
    ? Math.max(0, Math.min(5, Math.round(body.maxDiscoveryDepth)))
    : typeof body.maxDepth === 'number'
      ? Math.max(0, Math.min(5, Math.round(body.maxDepth)))
      : undefined;
  const includePaths = Array.isArray(body.includePaths)
    ? (body.includePaths as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 20)
    : undefined;
  const excludePaths = Array.isArray(body.excludePaths)
    ? (body.excludePaths as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 20)
    : undefined;
  const allowSubdomains = body.allowSubdomains === true;
  const crawlEntireDomain = body.crawlEntireDomain === true;
  const pollMs = typeof body.pollMs === 'number'
    ? Math.max(500, Math.min(5_000, Math.round(body.pollMs)))
    : 2_000;
  const maxWaitMs = typeof body.maxWaitMs === 'number'
    ? Math.max(5_000, Math.min(180_000, Math.round(body.maxWaitMs)))
    : 90_000;

  const payload: Record<string, unknown> = {
    url,
    limit,
    scrapeOptions: {
      formats: ['markdown'],
      onlyMainContent: true,
    },
  };
  if (maxDiscoveryDepth != null) {
    // v1 used maxDepth; v2 maxDiscoveryDepth — send both for compatibility
    payload.maxDepth = maxDiscoveryDepth;
    payload.maxDiscoveryDepth = maxDiscoveryDepth;
  }
  if (includePaths?.length) payload.includePaths = includePaths;
  if (excludePaths?.length) payload.excludePaths = excludePaths;
  if (allowSubdomains) {
    payload.allowSubdomains = true;
    payload.allowSubdomainsV2 = true;
  }
  if (crawlEntireDomain) payload.crawlEntireDomain = true;

  const start = await fcFetch(apiKey, '/crawl', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!start.ok) {
    sendJson(res, 200, {
      configured: true,
      ok: false,
      error: fcError(start.json, start.status),
      status: start.status,
    });
    return;
  }

  const jobId = String(start.json.id ?? (start.json.data as { id?: string } | undefined)?.id ?? '');
  if (!jobId) {
    sendJson(res, 200, {
      configured: true,
      ok: false,
      error: 'Firecrawl crawl did not return a job id',
      raw: start.json,
    });
    return;
  }

  const deadline = Date.now() + maxWaitMs;
  let lastStatus = 'scraping';
  let pages: Record<string, unknown>[] = [];

  while (Date.now() < deadline) {
    await sleep(pollMs);
    const st = await fcFetch(apiKey, `/crawl/${encodeURIComponent(jobId)}`, { method: 'GET' });
    if (!st.ok) {
      sendJson(res, 200, {
        configured: true,
        ok: false,
        error: fcError(st.json, st.status),
        crawlId: jobId,
        status: st.status,
      });
      return;
    }
    const d = st.json as Record<string, unknown>;
    lastStatus = String(d.status ?? d.state ?? 'unknown');
    const dataArr = Array.isArray(d.data) ? d.data as Record<string, unknown>[] : [];
    if (dataArr.length) pages = dataArr;

    if (lastStatus === 'completed' || lastStatus === 'failed' || lastStatus === 'cancelled') {
      break;
    }
    log(`[crawl] id=${jobId} status=${lastStatus} pages=${pages.length}`);
  }

  if (lastStatus !== 'completed' && !pages.length) {
    sendJson(res, 200, {
      configured: true,
      ok: false,
      error: `crawl not completed (status=${lastStatus}) within ${maxWaitMs}ms`,
      crawlId: jobId,
      status: lastStatus,
      partialCount: pages.length,
    });
    return;
  }

  const slim = pages.slice(0, limit).map((p) => {
    const meta = (p.metadata ?? {}) as Record<string, unknown>;
    const pageUrl = String(meta.sourceURL ?? meta.url ?? p.url ?? '');
    const md = typeof p.markdown === 'string' ? truncate(p.markdown, 8_000) : undefined;
    return {
      url: pageUrl,
      title: meta.title,
      markdown: md,
      statusCode: meta.statusCode,
    };
  });

  sendJson(res, 200, {
    configured: true,
    ok: lastStatus === 'completed' || slim.length > 0,
    crawlId: jobId,
    status: lastStatus,
    url,
    count: slim.length,
    pages: slim,
  });
}

/** Batch scrape many known URLs (official v2 /batch/scrape + status poll). */
export async function handleBatchScrape(
  apiKey: string,
  body: Record<string, unknown>,
  res: ServerResponse,
  log: (m: string) => void,
): Promise<void> {
  const rawUrls = Array.isArray(body.urls) ? body.urls : [];
  const urls = rawUrls
    .filter((u): u is string => typeof u === 'string')
    .map((u) => u.trim())
    .filter((u) => isHttpUrl(u))
    .slice(0, 15);
  if (!urls.length) {
    sendJson(res, 400, { error: 'urls must be a non-empty array of http(s) URIs (max 15)' });
    return;
  }

  const formatsIn = Array.isArray(body.formats)
    ? (body.formats as string[]).filter((f): f is SourceFormat => typeof f === 'string') as SourceFormat[]
    : (['markdown'] as SourceFormat[]);
  const onlyMainContent = body.onlyMainContent !== false;
  const pollMs = typeof body.pollMs === 'number'
    ? Math.max(500, Math.min(5_000, Math.round(body.pollMs)))
    : 2_000;
  const maxWaitMs = typeof body.maxWaitMs === 'number'
    ? Math.max(5_000, Math.min(180_000, Math.round(body.maxWaitMs)))
    : 90_000;

  const payload: Record<string, unknown> = {
    urls,
    formats: mapFormats(formatsIn, false),
    onlyMainContent,
    ignoreInvalidURLs: true,
  };

  // Official batch is v2
  const start = await fcFetch(apiKey, '/batch/scrape', {
    method: 'POST',
    body: JSON.stringify(payload),
  }, FC_V2);
  if (!start.ok) {
    sendJson(res, 200, {
      configured: true,
      ok: false,
      error: fcError(start.json, start.status),
      status: start.status,
    });
    return;
  }

  const jobId = String(start.json.id ?? (start.json.data as { id?: string } | undefined)?.id ?? '');
  if (!jobId) {
    sendJson(res, 200, {
      configured: true,
      ok: false,
      error: 'Firecrawl batch scrape did not return a job id',
      raw: start.json,
    });
    return;
  }

  const invalidURLs = Array.isArray(start.json.invalidURLs)
    ? start.json.invalidURLs
    : undefined;

  const deadline = Date.now() + maxWaitMs;
  let lastStatus = 'scraping';
  let pages: Record<string, unknown>[] = [];
  let creditsUsed: unknown = null;
  let total = 0;
  let completed = 0;

  while (Date.now() < deadline) {
    await sleep(pollMs);
    const st = await fcFetch(
      apiKey,
      `/batch/scrape/${encodeURIComponent(jobId)}`,
      { method: 'GET' },
      FC_V2,
    );
    if (!st.ok) {
      sendJson(res, 200, {
        configured: true,
        ok: false,
        error: fcError(st.json, st.status),
        batchId: jobId,
        status: st.status,
      });
      return;
    }
    const d = st.json as Record<string, unknown>;
    lastStatus = String(d.status ?? 'unknown');
    total = typeof d.total === 'number' ? d.total : total;
    completed = typeof d.completed === 'number' ? d.completed : completed;
    creditsUsed = d.creditsUsed ?? creditsUsed;
    const dataArr = Array.isArray(d.data) ? d.data as Record<string, unknown>[] : [];
    if (dataArr.length) pages = dataArr;

    if (lastStatus === 'completed' || lastStatus === 'failed' || lastStatus === 'cancelled') {
      break;
    }
    log(`[batch] id=${jobId} status=${lastStatus} completed=${completed}/${total}`);
  }

  if (lastStatus !== 'completed' && !pages.length) {
    sendJson(res, 200, {
      configured: true,
      ok: false,
      error: `batch not completed (status=${lastStatus}) within ${maxWaitMs}ms`,
      batchId: jobId,
      status: lastStatus,
      partialCount: pages.length,
      completed,
      total,
    });
    return;
  }

  const want = new Set(formatsIn.length ? formatsIn : ['markdown']);
  const slim = pages.map((p) => {
    const meta = (p.metadata ?? {}) as Record<string, unknown>;
    const pageUrl = String(meta.sourceURL ?? meta.url ?? p.url ?? '');
    const row: Record<string, unknown> = {
      url: pageUrl,
      title: meta.title,
      statusCode: meta.statusCode,
    };
    if (want.has('markdown') && typeof p.markdown === 'string') {
      row.markdown = truncate(p.markdown, 8_000);
    }
    if (want.has('summary') && p.summary != null) row.summary = p.summary;
    if (want.has('branding') && p.branding != null) row.branding = p.branding;
    if (want.has('links') && Array.isArray(p.links)) row.links = (p.links as string[]).slice(0, 40);
    if (meta.error) row.error = meta.error;
    return row;
  });

  sendJson(res, 200, {
    configured: true,
    ok: lastStatus === 'completed' || slim.length > 0,
    batchId: jobId,
    status: lastStatus,
    count: slim.length,
    completed,
    total,
    creditsUsed,
    invalidURLs,
    pages: slim,
  });
}
