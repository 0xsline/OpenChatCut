import type { AgentToolSchema } from '../tool-schema';

// fetch_trending_topics: pull current geopolitical/conflict/economy headlines from a free
// Google News RSS feed (proxied server-side at /api/news-trending — no API key needed).
// Use this when the user has NO specific topic ("apa yang lagi viral?", "kamu pilih")
// instead of asking them for one. Returns structured items: title, source, date, link.

export const NEWS_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'fetch_trending_topics',
    description: [
      'Fetch CURRENT trending news headlines (default: Indonesia-locale geopolitics / conflict / diplomacy / global economy) from a free Google News RSS feed — no API key needed.',
      'Use this FIRST when the user gives no specific topic (e.g. "bikin video geopolitik", "apa yang lagi viral", "kamu pilih aja") instead of asking them for a topic.',
      'Returns recent items with title, source, date, and link. Pick 2–3 concrete, Indonesia-relevant, video-worthy topics from the results and propose them (with a one-line Indonesia angle each), then proceed on one.',
      'Optional query narrows the feed (e.g. "Iran AS", "Laut Cina Selatan", "minyak"); gl/hl change locale; limit caps items.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional search terms to narrow the feed (Indonesian or English). Omit for the default geopolitical/conflict/economy feed.',
        },
        gl: { type: 'string', description: "Google News geo country code (default 'ID')." },
        hl: { type: 'string', description: "Google News language code (default 'id')." },
        limit: { type: 'number', description: 'Max items to return 1–40 (default 15).' },
      },
      required: [],
    },
  },
];

export const NEWS_TOOL_NAMES = new Set(NEWS_TOOL_SCHEMAS.map((t) => t.name));

type Args = Record<string, unknown>;

export async function execNewsTool(name: string, args: Args): Promise<unknown> {
  if (name !== 'fetch_trending_topics') return { error: `unknown tool ${name}` };
  const body: Record<string, unknown> = {};
  if (typeof args.query === 'string' && args.query.trim()) body.query = args.query.trim();
  if (typeof args.gl === 'string' && args.gl.trim()) body.gl = args.gl.trim();
  if (typeof args.hl === 'string' && args.hl.trim()) body.hl = args.hl.trim();
  if (typeof args.limit === 'number') body.limit = args.limit;

  let res: Response;
  try {
    res = await fetch('/api/news-trending', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return {
      error: `request failed: ${e instanceof Error ? e.message : String(e)}`,
      hint: 'Is the Vite/Electron dev server running? The /api/news-trending proxy lives server-side.',
    };
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (data.ok !== true) {
    return {
      ok: false,
      error: data.error ?? 'news fetch failed',
      ...(data.hint ? { hint: data.hint } : {}),
    };
  }
  return {
    ok: true,
    query: data.query,
    locale: data.locale,
    count: data.count,
    asOf: data.asOf,
    items: data.items,
    note: 'Pick 2-3 Indonesia-relevant, video-worthy topics from these headlines. For each, note the Indonesia angle (BBM/LPG/TKI/ekspor/rupiah/regional security). Then propose them to the user and proceed — do NOT just ask "what topic?".',
  };
}
