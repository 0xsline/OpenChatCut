import { createServerExporter } from './serverExportOperation';
import type { ExportDestination } from './exportDestination';

const renderIds = [
  'render-failed',
  'render-succeeded',
  'render-active',
  'render-cancelled',
  'render-save-cancelled',
  'render-qa-cancelled',
  'render-save-completed',
];

function nextRenderId(): string {
  const renderId = renderIds.shift();
  if (!renderId) throw new Error('unexpected server export launch');
  return renderId;
}

const grantId = 'a'.repeat(43);
export const destination: ExportDestination = {
  type: 'desktop-directory',
  grantId,
  label: 'Exports',
};
export const noop = () => undefined;

export interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

export function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

export function exporter(exportDestination: ExportDestination = destination) {
  return createServerExporter({
    createOperationId: nextRenderId,
    autoQaEnabled: false,
    destination: exportDestination,
    beginTargetCommit: noop,
    endTargetCommit: noop,
    markTargetCommitted: noop,
    options: {
      state: {} as never,
      projectId: 'project-lifecycle',
      projectName: 'Lifecycle',
      base: 'lifecycle',
      tab: 'video',
      codec: 'h264',
      resolution: '1080p',
      fps: 30,
      subtitleFormat: 'srt',
      subtitleCaptions: null,
      nleFormat: 'fcp_xml',
      includeMg: false,
      mgItems: [],
      onClose: noop,
    },
    setBusy: noop,
    setEngineInfo: noop,
    setEngineReason: noop,
    setProgress: noop,
    setRenderEngine: noop,
    t: (key) => key,
    verifyCompletedExport: async () => undefined,
  });
}
