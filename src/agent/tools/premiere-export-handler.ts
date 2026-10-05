import type { TimelineState } from '../../editor/types';
import { exportMediaSources, fcpxmlMediaLocations } from '../../export/exportMediaSources';
import { planPremiereExport } from '../../export/premiereBakePlan';
import { renderPremiereBakeJobs } from '../../export/premiereBake';
import { timelineToPremiereXml } from '../../export/premiereXml';
import type { PremiereExportIssue } from '../../export/premiereTypes';
import { recordExport } from '../../persist/exportHistoryStore';
import type { GenerateArgs } from './generate-tool-input';
export async function exportPremiereXml(args: GenerateArgs, state: TimelineState): Promise<unknown> {
  const plan = planPremiereExport(state);
  const issues: PremiereExportIssue[] = [...plan.issues];
  const blocking = issues.filter((issue) => issue.severity === 'error');
  if (blocking.length) {
    return { ok: false, format: 'xml', nleFormat: 'premiere_xml', issues, error: 'Premiere XML export is blocked by unsupported timeline content.' };
  }

  const rendered = await renderPremiereBakeJobs(state, plan);
  issues.push(...rendered.issues);
  if (rendered.issues.some((issue) => issue.severity === 'error')) {
    return { ok: false, format: 'xml', nleFormat: 'premiere_xml', issues, error: 'A required Premiere-compatible clip render failed; no XML was written.' };
  }

  const bakedMedia = Object.fromEntries(rendered.media);
  for (const job of plan.bakeJobs) {
    const source = bakedMedia[job.itemId]?.[job.kind === 'visual' ? 'visualSrc' : 'audioSrc'];
    if (!source) {
      const issue: PremiereExportIssue = {
        severity: 'error',
        code: 'premiere-required-bake-missing',
        message: `Required ${job.kind} render is missing for timeline item ${job.itemId}. No XML was written.`,
        itemIds: [job.itemId],
      };
      issues.push(issue);
      return { ok: false, format: 'xml', nleFormat: 'premiere_xml', issues, error: issue.message };
    }
  }

  const keys = Array.isArray(args.motionGraphicRenderKeys)
    ? args.motionGraphicRenderKeys.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
    : [];
  if (keys.length) {
    issues.push({
      severity: 'warning',
      code: 'premiere-motion-graphic-keys-ignored',
      message: 'motionGraphicRenderKeys only apply to the legacy FCPXML export. Premiere XML uses its own selective clip renders; the supplied keys were ignored.',
      itemIds: [],
    });
  }

  const bakedSources = Object.values(bakedMedia)
    .flatMap((item) => [item.visualSrc, item.audioSrc])
    .filter((source): source is string => typeof source === 'string' && !!source);
  const [{ mediaDir, mediaSources }, bakedSourcesMap] = await Promise.all([
    fcpxmlMediaLocations(state),
    exportMediaSources(bakedSources),
  ]);
  const isLocalDiskPath = (value: unknown): value is string => typeof value === 'string'
    && (/^file:\/\//i.test(value)
      || value.startsWith('/')
      || /^[A-Za-z]:[\\/]/.test(value)
      || value.startsWith('\\\\'));
  const unresolvedItems = state.items.filter((item) => {
    if (!item.src) return false;
    const asset = item.sourceAssetId
      ? state.assets?.find((candidate) => candidate.id === item.sourceAssetId)
      : state.assets?.find((candidate) => candidate.src === item.src);
    const located = mediaSources[item.src];
    return !isLocalDiskPath(located?.path)
      && !isLocalDiskPath(located?.originalPath)
      && !isLocalDiskPath(item.originalFilePath)
      && !isLocalDiskPath(asset?.originalFilePath)
      && (item.src.startsWith('/media/uploads/') || !isLocalDiskPath(item.src));
  });
  const unresolvedBakes = bakedSources.filter((src) => {
    const located = bakedSourcesMap[src];
    return !isLocalDiskPath(located?.path) && !isLocalDiskPath(located?.originalPath);
  });
  if (unresolvedItems.length || unresolvedBakes.length) {
    const pathIssues: PremiereExportIssue[] = [
      ...unresolvedItems.map((item): PremiereExportIssue => ({
        severity: 'error',
        code: 'premiere-source-path-unresolved',
        message: `${item.name} has no resolved local media path; restore/relink the source before exporting Premiere XML.`,
        itemIds: [item.id],
      })),
      ...unresolvedBakes.map((src): PremiereExportIssue => ({
        severity: 'error',
        code: 'premiere-bake-path-unresolved',
        message: `Rendered media has no resolved local path (${src}); no Premiere XML was written.`,
        itemIds: [],
      })),
    ];
    const allIssues = [...issues, ...pathIssues];
    return {
      ok: false,
      format: 'xml',
      nleFormat: 'premiere_xml',
      issues: allIssues,
      error: pathIssues.map((issue) => issue.message).join('\n'),
    };
  }
  const base = (typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'timeline')
    .replace(/\.(?:fcpxml|xml)$/i, '');
  const filename = `${base}-premiere.xml`;
  let xml: string;
  try {
    xml = timelineToPremiereXml(state, {
      title: typeof args.name === 'string' ? args.name : undefined,
      mediaDir,
      mediaSources: { ...mediaSources, ...bakedSourcesMap },
      bakedMedia,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const issue: PremiereExportIssue = {
      severity: 'error',
      code: 'premiere-xml-serialization-failed',
      message,
      itemIds: [],
    };
    issues.push(issue);
    return { ok: false, format: 'xml', nleFormat: 'premiere_xml', issues, error: message };
  }

  const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  void recordExport({ name: filename, format: 'xml', sizeBytes: blob.size, createdAt: Date.now() });
  return {
    ok: true,
    format: 'xml',
    nleFormat: 'premiere_xml',
    name: filename,
    sizeBytes: blob.size,
    bakedItemIds: [...rendered.media.keys()],
    issues,
    premiereImportVerified: false,
  };
}
