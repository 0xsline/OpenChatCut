export { LIBRARY_TOOL_SCHEMAS, LIBRARY_TOOL_NAMES } from './schemas/library-tools';
import type { AgentContext } from '../context';
import {
  buildLibraryItems,
  LIBRARY_CATEGORIES,
  libraryOverview,
  type LibraryCategory,
  type LibraryItem,
} from './library-catalog';

// browse_library — unified Library discovery (not user media pool).
// List is compact (id/name/category/description); id mode returns usage guidance.
// Placement is always a separate edit_item call.

type Args = Record<string, unknown>;

function scoreQuery(it: LibraryItem, q: string): boolean {
  const hay = `${it.id} ${it.name} ${it.category} ${it.group ?? ''} ${it.description}`.toLowerCase();
  return q.split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

function compact(it: LibraryItem) {
  return {
    id: it.id,
    name: it.name,
    category: it.category,
    description: it.description,
    ...(it.group ? { group: it.group } : {}),
  };
}

export async function execLibraryTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'browse_library') return { error: `unknown tool ${name}` };

  const all = buildLibraryItems(ctx.templates);
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (id) {
    const hit = all.find((x) => x.id === id || x.id.endsWith(id) || x.id.includes(id));
    if (!hit) {
      return {
        error: `unknown library id ${id}`,
        hint: 'Call browse_library with category or query first.',
        categories: LIBRARY_CATEGORIES,
      };
    }
    return {
      mode: 'detail',
      item: { ...compact(hit), usage: hit.usage },
    };
  }

  const cat = typeof args.category === 'string' ? (args.category as LibraryCategory) : null;
  const group = typeof args.group === 'string' ? args.group.trim() : '';
  const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
  const limit = Math.min(50, Math.max(1, Number(args.limit) || 30));
  const offset = Math.max(0, Number(args.offset) || 0);

  // overview: category only, no group/query
  if (cat && !group && !query) {
    const scoped = all.filter((x) => x.category === cat);
    if (cat === 'audio-fx') {
      // Re-enabled open-box isolate_voice (ffmpeg). Still point agents at isolate_voice tool.
      const overview = libraryOverview(scoped);
      return {
        category: cat,
        ...overview,
        note: 'Apply with isolate_voice (not edit_item). strength 0..100; action=clear detaches denoisedSrc.',
      };
    }
    return { category: cat, ...libraryOverview(scoped) };
  }

  // list mode
  let list = all;
  if (cat) list = list.filter((x) => x.category === cat);
  if (group) {
    const g = group.toLowerCase();
    list = list.filter((x) => (x.group ?? '').toLowerCase() === g || (x.group ?? '').toLowerCase().includes(g));
  }
  if (query) list = list.filter((x) => scoreQuery(x, query));

  // no filters at all → top-level category counts
  if (!cat && !group && !query) {
    const counts: Record<string, number> = {};
    for (const c of LIBRARY_CATEGORIES) counts[c] = all.filter((x) => x.category === c).length;
    return {
      mode: 'root',
      categories: counts,
      total: all.length,
      usage: 'Pass category (and optional group/query) or id. Then edit_item to place.',
    };
  }

  const slice = list.slice(offset, offset + limit);
  return {
    mode: 'list',
    hasMore: offset + slice.length < list.length,
    limit,
    offset,
    total: list.length,
    results: slice.map(compact),
  };
}
