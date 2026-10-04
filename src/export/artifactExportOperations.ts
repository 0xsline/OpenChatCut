import { captionsToSrt, captionsToTxt } from '../captions/exportCaptions';
import type { TimelineItem, TimelineState } from '../editor/types';
import { renderClipMovBlob } from '../media/clipExport';
import { recordExport } from '../persist/exportHistoryStore';
import {
  exportDestinationFilename,
  exportHistoryDestinationId,
  writeBlobToDestination,
  type ExportDestination,
} from './exportDestination';
import { timelineToFcpxml } from './fcpxml';
import { exportMediaSources, fcpxmlMediaLocations } from './exportMediaSources';
import { timelineToPremiereXml } from './premiereXml';
import { planPremiereExport } from './premiereBakePlan';
import { renderPremiereBakeJobs } from './premiereBake';
import type { PremiereExportIssue, PremiereXmlExportOptions } from './premiereTypes';
import { motionGraphicRenderFilename, motionGraphicRenderKey } from './motionGraphicRefs';
import type {
  ExportProgress,
  StateSetter,
  Translate,
  UseExportWorkflowOptions,
} from './exportWorkflowTypes';

interface ArtifactExportContext {
  destination: ExportDestination;
  beginTargetCommit(): void;
  endTargetCommit(): void;
  markTargetCommitted(): void;
  options: UseExportWorkflowOptions;
  setBusy: StateSetter<string | null>;
  setProgress: StateSetter<ExportProgress | null>;
  t: Translate;
}


async function writeArtifactBlob(
  context: ArtifactExportContext,
  destination: ExportDestination,
  filename: string,
  blob: Blob,
  finalTarget: boolean,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  context.beginTargetCommit();
  try {
    await writeBlobToDestination(destination, filename, blob, signal);
    if (finalTarget) context.markTargetCommitted();
    else context.endTargetCommit();
  } catch (error) {
    context.endTargetCommit();
    throw error;
  }
  if (!finalTarget) signal?.throwIfAborted();
}

async function exportMgBatch(context: ArtifactExportContext, signal?: AbortSignal): Promise<void> {
  const { mgItems, state } = context.options;
  signal?.throwIfAborted();
  for (let index = 0; index < mgItems.length; index++) {
    signal?.throwIfAborted();
    const item = mgItems[index];
    context.setBusy(context.t('渲染 MG {i}/{n} · {name}', { i: index + 1, n: mgItems.length, name: item.name }));
    context.setProgress((current) => current ? {
      ...current,
      phase: 'rendering',
      percent: Math.round((index / mgItems.length) * 95),
      detail: context.t('正在渲染第 {i}/{n} 个动态图层', { i: index + 1, n: mgItems.length }),
    } : current);
    signal?.throwIfAborted();
    const rendered = await renderClipMovBlob(state, item, { signal });
    signal?.throwIfAborted();
    await writeArtifactBlob(
      context,
      context.destination,
      rendered.filename,
      rendered.blob,
      index === mgItems.length - 1,
      signal,
    );
  }
  const destinationId = exportHistoryDestinationId(context.destination);
  void recordExport({
    name: `${mgItems.length} 个 MG · ProRes 4444`,
    format: 'video',
    codec: 'prores',
    createdAt: Date.now(),
    ...(destinationId ? { destinationId } : {}),
  });
}

async function exportSubtitles(context: ArtifactExportContext, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const { subtitleCaptions, subtitleFormat, state, base } = context.options;
  if (!subtitleCaptions) throw new Error(context.t('请先开启字幕'));
  const text = subtitleFormat === 'srt'
    ? captionsToSrt(subtitleCaptions, state.items, state.fps)
    : captionsToTxt(subtitleCaptions, state.items, state.fps);
  signal?.throwIfAborted();
  if (!text) throw new Error(context.t('当前字幕轨没有可导出的内容'));
  const filename = `${base}.${subtitleFormat}`;
  await writeArtifactBlob(
    context,
    context.destination,
    filename,
    new Blob([text], { type: 'text/plain;charset=utf-8' }),
    true,
    signal,
  );
  const destinationId = exportHistoryDestinationId(context.destination);
  const historyName = exportDestinationFilename(context.destination, filename);
  void recordExport({
    name: historyName,
    format: 'subtitles',
    createdAt: Date.now(),
    ...(destinationId ? { destinationId } : {}),
  });
}

function uniqueMgItems(items: TimelineItem[]): Array<[string, TimelineItem]> {
  return Array.from(new Map(items.map((item) => [motionGraphicRenderKey(item), item] as const)).entries());
}

async function renderXmlMgItems(
  context: ArtifactExportContext,
  destination: ExportDestination,
  successfulRenderKeys: string[],
  failedRenderNames: string[],
  signal?: AbortSignal,
): Promise<void> {
  const items = uniqueMgItems(context.options.mgItems);
  signal?.throwIfAborted();
  for (let index = 0; index < items.length; index++) {
    signal?.throwIfAborted();
    const [renderKey, item] = items[index];
    context.setBusy(context.t('渲染 MG {i}/{n} · {name}', { i: index + 1, n: items.length, name: item.name }));
    context.setProgress((current) => current ? {
      ...current,
      phase: 'rendering',
      percent: Math.round((index / items.length) * 90),
      detail: context.t('正在渲染第 {i}/{n} 个动态图层', { i: index + 1, n: items.length }),
    } : current);
    try {
      signal?.throwIfAborted();
      const rendered = await renderClipMovBlob(context.options.state, item, {
        filename: motionGraphicRenderFilename(renderKey),
        signal,
      });
      signal?.throwIfAborted();
      await writeArtifactBlob(context, destination, rendered.filename, rendered.blob, false, signal);
      successfulRenderKeys.push(renderKey);
    } catch {
      signal?.throwIfAborted();
      failedRenderNames.push(item.name);
    }
  }
  signal?.throwIfAborted();
}

async function writeXml(
  context: ArtifactExportContext,
  destination: ExportDestination,
  keys: string[],
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const { state, projectName, nleFormat, base } = context.options;
  const { mediaDir, mediaSources } = await fcpxmlMediaLocations(state, fetch, signal);
  signal?.throwIfAborted();
  const fcpxmlFormat = nleFormat === 'fcp_xml_resolve' ? 'fcp_xml_resolve' : 'fcp_xml';
  const xml = timelineToFcpxml(state, {
    title: projectName,
    nleFormat: fcpxmlFormat,
    motionGraphicRenderKeys: keys,
    mediaDir,
    mediaSources,
  });
  signal?.throwIfAborted();
  const suffix = nleFormat === 'fcp_xml_resolve' ? 'resolve' : 'final-cut';
  const filename = `${base}-${suffix}.fcpxml`;
  const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
  await writeArtifactBlob(context, destination, filename, blob, true, signal);
  return filename;
}

function premiereIssueMessages(issues: readonly PremiereExportIssue[]): string[] {
  return issues.map((issue) => issue.message);
}

function isLocalDiskPath(value: string | undefined): boolean {
  return !!value && (/^file:\/\//i.test(value)
    || value.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(value)
    || value.startsWith('\\\\'));
}

function hasResolvedPremiereMediaPath(
  state: TimelineState,
  item: TimelineItem,
  mediaSources: Readonly<Record<string, { path?: string; originalPath?: string }>>,
): boolean {
  const src = item.src;
  if (!src) return true;
  const asset = item.sourceAssetId
    ? state.assets?.find((candidate) => candidate.id === item.sourceAssetId)
    : state.assets?.find((candidate) => candidate.src === src);
  const located = mediaSources[src];
  return isLocalDiskPath(located?.path)
    || isLocalDiskPath(located?.originalPath)
    || isLocalDiskPath(item.originalFilePath)
    || isLocalDiskPath(asset?.originalFilePath)
    || (!src.startsWith('/media/uploads/') && isLocalDiskPath(src));
}

async function exportPremiereXml(context: ArtifactExportContext, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const { state, projectName, base } = context.options;
  const plan = planPremiereExport(state);
  const blocking = plan.issues.filter((issue) => issue.severity === 'error');
  const initialMessages = premiereIssueMessages(plan.issues);
  context.setProgress((current) => current ? {
    ...current,
    detail: blocking.length
      ? context.t('当前时间线有 {n} 个导出限制。', { n: blocking.length })
      : plan.bakeJobs.length
        ? context.t('将渲染 {n} 个 Premiere 兼容片段。', { n: plan.bakeJobs.length })
        : context.t('正在准备 Premiere XML 工程…'),
    notices: initialMessages,
  } : current);
  if (blocking.length) {
    throw new Error(blocking.map((issue) => issue.message).join('\n'));
  }

  const rendered = await renderPremiereBakeJobs(state, plan, {
    signal,
    onProgress(job, index, total) {
      context.setBusy(context.t('渲染 Premiere 兼容片段 {i}/{n}', { i: index, n: total }));
      context.setProgress((current) => current ? {
        ...current,
        phase: 'rendering',
        percent: Math.min(75, Math.round(5 + (index / Math.max(1, total)) * 70)),
        detail: job.reasons.join(' '),
      } : current);
    },
  });
  signal?.throwIfAborted();
  const issues = [...plan.issues, ...rendered.issues];
  const renderErrors = rendered.issues.filter((issue) => issue.severity === 'error');
  if (renderErrors.length) {
    context.setProgress((current) => current ? {
      ...current,
      detail: context.t('片段渲染失败，未生成 Premiere XML。'),
      notices: premiereIssueMessages(issues),
    } : current);
    throw new Error(renderErrors.map((issue) => issue.message).join('\n'));
  }

  const bakedMedia = Object.fromEntries(rendered.media);
  for (const job of plan.bakeJobs) {
    const source = bakedMedia[job.itemId]?.[job.kind === 'visual' ? 'visualSrc' : 'audioSrc'];
    if (!source) {
      const message = context.t('片段 {id} 缺少已渲染媒体，未生成 Premiere XML。', { id: job.itemId });
      context.setProgress((current) => current ? {
        ...current, detail: message, notices: [...premiereIssueMessages(issues), message],
      } : current);
      throw new Error(message);
    }
  }

  const bakedSources = Object.values(bakedMedia)
    .flatMap((item) => [item.visualSrc, item.audioSrc])
    .filter((source): source is string => typeof source === 'string' && !!source);
  const [{ mediaDir, mediaSources }, bakedSourcesMap] = await Promise.all([
    fcpxmlMediaLocations(state, fetch, signal),
    exportMediaSources(bakedSources, fetch, signal),
  ]);
  signal?.throwIfAborted();
  const unresolvedItems = state.items.filter((item) => !hasResolvedPremiereMediaPath(state, item, mediaSources));
  const unresolvedBakes = bakedSources.filter((src) => {
    const located = bakedSourcesMap[src];
    return !isLocalDiskPath(located?.path) && !isLocalDiskPath(located?.originalPath);
  });
  const unresolved = [
    ...unresolvedItems.map((item): PremiereExportIssue => ({
      severity: 'error',
      code: 'premiere-source-path-unresolved',
      message: context.t('素材 {name} 没有可用的本机路径；未生成 Premiere XML。请恢复素材链接后重试。', { name: item.name }),
      itemIds: [item.id],
    })),
    ...unresolvedBakes.map((src): PremiereExportIssue => ({
      severity: 'error',
      code: 'premiere-bake-path-unresolved',
      message: context.t('已渲染片段没有可用的本机路径；未生成 Premiere XML。', { src }),
      itemIds: [],
    })),
  ];
  if (unresolved.length) {
    const allIssues = [...issues, ...unresolved];
    context.setProgress((current) => current ? {
      ...current,
      detail: unresolved[0]!.message,
      notices: premiereIssueMessages(allIssues),
    } : current);
    throw new Error(unresolved.map((issue) => issue.message).join('\n'));
  }
  const options: PremiereXmlExportOptions = {
    title: projectName,
    mediaDir,
    mediaSources: { ...mediaSources, ...bakedSourcesMap },
    bakedMedia,
  };
  const xml = timelineToPremiereXml(state, options);
  signal?.throwIfAborted();
  const filename = `${base}-premiere.xml`;
  context.setBusy(context.t('正在写入 Premiere XML…'));
  context.setProgress((current) => current ? {
    ...current,
    phase: 'finalizing',
    percent: 90,
    detail: context.t('正在写入 Premiere XML 工程。'),
    notices: premiereIssueMessages(issues),
  } : current);
  await writeArtifactBlob(
    context,
    context.destination,
    filename,
    new Blob([xml], { type: 'application/xml;charset=utf-8' }),
    true,
    signal,
  );
  const destinationId = exportHistoryDestinationId(context.destination);
  const historyName = exportDestinationFilename(context.destination, filename);
  void recordExport({
    name: historyName,
    format: 'xml',
    createdAt: Date.now(),
    ...(destinationId ? { destinationId } : {}),
  });
  if (issues.length) {
    context.setProgress((current) => current ? {
      ...current,
      detail: context.t('已导出 Premiere XML，包含 {n} 条兼容性说明。', { n: issues.length }),
      notices: premiereIssueMessages(issues),
    } : current);
  }
}

async function exportXml(context: ArtifactExportContext, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (context.options.nleFormat === 'premiere_xml') {
    await exportPremiereXml(context, signal);
    return;
  }
  const destination = context.destination;
  const successfulRenderKeys: string[] = [];
  const failedRenderNames: string[] = [];
  if (context.options.includeMg) {
    await renderXmlMgItems(context, destination, successfulRenderKeys, failedRenderNames, signal);
  }
  signal?.throwIfAborted();
  const filename = await writeXml(context, destination, successfulRenderKeys, signal);
  const destinationId = exportHistoryDestinationId(context.destination);
  const historyName = exportDestinationFilename(context.destination, filename);
  void recordExport({
    name: historyName,
    format: 'xml',
    createdAt: Date.now(),
    ...(destinationId ? { destinationId } : {}),
  });
  if (failedRenderNames.length) {
    context.setProgress((current) => current ? {
      ...current,
      detail: context.t('{n} 个动态图层渲染失败，XML 已保留占位', { n: failedRenderNames.length }),
    } : current);
  }
}

export function createArtifactExporters(context: ArtifactExportContext) {
  return {
    exportMg: (signal?: AbortSignal) => exportMgBatch(context, signal),
    exportSubtitles: (signal?: AbortSignal) => exportSubtitles(context, signal),
    exportXml: (signal?: AbortSignal) => exportXml(context, signal),
  };
}
