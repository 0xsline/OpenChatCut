import { captionsToSrt, captionsToTxt } from '../captions/exportCaptions';
import type { TimelineItem } from '../editor/types';
import { renderClipMovBlob } from '../media/clipExport';
import { recordExport } from '../persist/exportHistoryStore';
import {
  exportDestinationFilename,
  exportHistoryDestinationId,
  writeBlobToDestination,
  type ExportDestination,
} from './exportDestination';
import { timelineToFcpxml } from './fcpxml';
import { exportMediaDir } from './mediaDir';
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
  const mediaDir = await exportMediaDir();
  signal?.throwIfAborted();
  const xml = timelineToFcpxml(state, {
    title: projectName,
    nleFormat,
    motionGraphicRenderKeys: keys,
    mediaDir,
  });
  signal?.throwIfAborted();
  const suffix = nleFormat === 'fcp_xml_resolve' ? 'resolve' : 'premiere';
  const filename = `${base}-${suffix}.fcpxml`;
  const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
  await writeArtifactBlob(context, destination, filename, blob, true, signal);
  return filename;
}

async function exportXml(context: ArtifactExportContext, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
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
