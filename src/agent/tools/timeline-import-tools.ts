// import_timeline: FCPXML / CMX 3600 EDL → a new editable timeline.
// Parsing lives in timeline-import-fcpxml*.ts and timeline-import-edl.ts, the
// shared lane/track layout in timeline-import-layout.ts, and draft building in
// timeline-import-build.ts. The schema is in schemas/timeline-import-tools.ts.
import type { AgentContext } from '../context';
import type { MediaAsset, TimelineState } from '../../editor/types';
import { makeDraft } from '../../editor/store';
import { buildImportedTimeline } from './timeline-import-build';
import { parseEdl } from './timeline-import-edl';
import { parseFcpxml } from './timeline-import-fcpxml';
import type { ParseResult, TimelineImportOptions } from './timeline-import-types';
import type { XmlParserConstructor } from './timeline-import-xml';

export type { ParseResult, TimelineImportOptions } from './timeline-import-types';

type ImportFormat = 'fcpxml' | 'edl';

const MAX_CONTENT_CHARS = 2_000_000;
/** Keep tool results bounded: long timelines can skip hundreds of transitions or titles. */
const MAX_REPORTED = 50;

async function xmlParser(): Promise<XmlParserConstructor> {
  if (typeof globalThis.DOMParser === 'function') {
    return globalThis.DOMParser as unknown as XmlParserConstructor;
  }
  return (await import('@xmldom/xmldom')).DOMParser;
}

export async function parseTimelineImport(
  format: ImportFormat,
  content: string,
  assets: readonly MediaAsset[],
  fallback: TimelineState,
  options: TimelineImportOptions = {},
): Promise<ParseResult> {
  if (!content.trim()) return { ok: false, error: 'content is required' };
  if (content.length > MAX_CONTENT_CHARS) return { ok: false, error: `content exceeds ${MAX_CONTENT_CHARS} characters` };
  const Parser = format === 'fcpxml' ? await xmlParser() : null;
  try {
    return Parser
      ? parseFcpxml(content, assets, fallback, Parser)
      : parseEdl(content, assets, fallback, options);
  } catch (error) {
    // e.g. a pathologically nested document exhausting the stack.
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `could not read the ${Parser ? 'FCPXML' : 'EDL'}: ${message}` };
  }
}

function importOptions(args: Record<string, unknown>): TimelineImportOptions {
  return {
    ...(typeof args.fps === 'number' ? { fps: args.fps } : {}),
    ...(typeof args.startTimecode === 'string' ? { startTimecode: args.startTimecode } : {}),
  };
}

export async function execTimelineImportTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentContext,
): Promise<Record<string, unknown>> {
  if (name !== 'import_timeline') return { error: `unknown tool ${name}` };
  const format = args.format === 'fcpxml' || args.format === 'edl' ? args.format : null;
  if (!format) return { error: 'format must be fcpxml or edl' };
  const options = importOptions(args);
  const parsed = await parseTimelineImport(
    format,
    typeof args.content === 'string' ? args.content : '',
    ctx.getDoc().assets,
    ctx.getState(),
    options,
  );
  if (!parsed.ok) {
    return parsed.skipped
      ? { ...parsed, skipped: parsed.skipped.slice(0, MAX_REPORTED), skippedCount: parsed.skipped.length }
      : parsed;
  }
  const report = { warnings: [...parsed.timeline.warnings], skipped: [...parsed.timeline.skipped] };
  const { fps, sourceFps } = parsed.timeline;
  if (sourceFps !== fps) {
    const rate = (value: number) => Number(value.toFixed(3));
    report.warnings.unshift(`the ${rate(sourceFps)} fps ${format === 'fcpxml' ? 'sequence' : 'list'} was converted to the project frame rate (${rate(fps)} fps); cut points are rounded to the nearest frame`);
  }
  if (format === 'fcpxml' && (options.fps !== undefined || options.startTimecode !== undefined)) {
    report.warnings.unshift('fps and startTimecode apply to EDL only; the FCPXML sequence format and tcStart were used');
  }
  const draft = makeDraft(ctx.getDoc());
  const importedName = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : parsed.timeline.name;
  const previousTimelineId = draft.getDoc().activeTimelineId;
  const built = buildImportedTimeline(draft, parsed.timeline, importedName, report);
  ctx.commands.applyDoc(args.activate === false
    ? { ...built.doc, activeTimelineId: previousTimelineId }
    : built.doc);
  return {
    ok: true,
    format,
    timelineId: built.timelineId,
    name: importedName,
    itemCount: built.itemCount,
    trackCount: built.trackCount,
    fps,
    ...(parsed.timeline.startTimecode ? { startTimecode: parsed.timeline.startTimecode } : {}),
    warnings: report.warnings.slice(0, MAX_REPORTED),
    ...(report.warnings.length > MAX_REPORTED ? { warningCount: report.warnings.length } : {}),
    skipped: report.skipped.slice(0, MAX_REPORTED),
    skippedCount: report.skipped.length,
  };
}
