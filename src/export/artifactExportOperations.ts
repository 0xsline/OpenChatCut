import { captionsToSrt, captionsToTxt } from '../captions/exportCaptions';
import type { TimelineItem } from '../editor/types';
import { exportClipMov, renderClipMovBlob } from '../media/clipExport';
import { recordExport } from '../persist/exportHistoryStore';
import { downloadBlob, selectExportDirectory, writeExportFile, type ExportDirectoryHandle } from './exportFiles';
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
  options: UseExportWorkflowOptions;
  setBusy: StateSetter<string | null>;
  setProgress: StateSetter<ExportProgress | null>;
  t: Translate;
}


async function exportMgBatch(context: ArtifactExportContext): Promise<void> {
  const { mgItems, state } = context.options;
  for (let index = 0; index < mgItems.length; index++) {
    const item = mgItems[index];
    context.setBusy(context.t('渲染 MG {i}/{n} · {name}', { i: index + 1, n: mgItems.length, name: item.name }));
    context.setProgress((current) => current ? {
      ...current,
      phase: 'rendering',
      percent: Math.round((index / mgItems.length) * 95),
      detail: context.t('正在渲染第 {i}/{n} 个动态图层', { i: index + 1, n: mgItems.length }),
    } : current);
    await exportClipMov(state, item);
  }
  void recordExport({ name: `${mgItems.length} 个 MG · ProRes 4444`, format: 'video', codec: 'prores', createdAt: Date.now() });
}

function exportSubtitles(context: ArtifactExportContext): void {
  const { subtitleCaptions, subtitleFormat, state, base } = context.options;
  if (!subtitleCaptions) throw new Error(context.t('请先开启字幕'));
  const text = subtitleFormat === 'srt'
    ? captionsToSrt(subtitleCaptions, state.items, state.fps)
    : captionsToTxt(subtitleCaptions, state.items, state.fps);
  if (!text) throw new Error(context.t('当前字幕轨没有可导出的内容'));
  const filename = `${base}.${subtitleFormat}`;
  downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), filename);
  void recordExport({ name: filename, format: 'subtitles', createdAt: Date.now() });
}

function uniqueMgItems(items: TimelineItem[]): Array<[string, TimelineItem]> {
  return Array.from(new Map(items.map((item) => [motionGraphicRenderKey(item), item] as const)).entries());
}

async function renderXmlMgItems(
  context: ArtifactExportContext,
  directory: ExportDirectoryHandle | null,
  successfulRenderKeys: string[],
  failedRenderNames: string[],
): Promise<void> {
  const items = uniqueMgItems(context.options.mgItems);
  for (let index = 0; index < items.length; index++) {
    const [renderKey, item] = items[index];
    context.setBusy(context.t('渲染 MG {i}/{n} · {name}', { i: index + 1, n: items.length, name: item.name }));
    context.setProgress((current) => current ? {
      ...current,
      phase: 'rendering',
      percent: Math.round((index / items.length) * 90),
      detail: context.t('正在渲染第 {i}/{n} 个动态图层', { i: index + 1, n: items.length }),
    } : current);
    try {
      const rendered = await renderClipMovBlob(context.options.state, item, { filename: motionGraphicRenderFilename(renderKey) });
      if (directory) await writeExportFile(directory, rendered.filename, rendered.blob);
      else downloadBlob(rendered.blob, rendered.filename);
      successfulRenderKeys.push(renderKey);
    } catch {
      failedRenderNames.push(item.name);
    }
  }
}

async function writeXml(context: ArtifactExportContext, directory: ExportDirectoryHandle | null, keys: string[]): Promise<string> {
  const { state, projectName, nleFormat, base } = context.options;
  const xml = timelineToFcpxml(state, {
    title: projectName,
    nleFormat,
    motionGraphicRenderKeys: keys,
    mediaDir: await exportMediaDir(),
  });
  const suffix = nleFormat === 'fcp_xml_resolve' ? 'resolve' : 'premiere';
  const filename = `${base}-${suffix}.fcpxml`;
  const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
  if (directory) await writeExportFile(directory, filename, blob);
  else downloadBlob(blob, filename);
  return filename;
}

async function exportXml(context: ArtifactExportContext): Promise<void> {
  const directory = context.options.includeMg ? await selectExportDirectory() : null;
  const successfulRenderKeys: string[] = [];
  const failedRenderNames: string[] = [];
  if (context.options.includeMg) {
    await renderXmlMgItems(context, directory, successfulRenderKeys, failedRenderNames);
  }
  const filename = await writeXml(context, directory, successfulRenderKeys);
  void recordExport({ name: filename, format: 'xml', createdAt: Date.now() });
  if (failedRenderNames.length) {
    context.setProgress((current) => current ? {
      ...current,
      detail: context.t('{n} 个动态图层渲染失败，XML 已保留占位', { n: failedRenderNames.length }),
    } : current);
  }
}

export function createArtifactExporters(context: ArtifactExportContext) {
  return {
    exportMg: () => exportMgBatch(context),
    exportSubtitles: () => exportSubtitles(context),
    exportXml: () => exportXml(context),
  };
}
