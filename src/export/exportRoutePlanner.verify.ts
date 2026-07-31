import assert from 'node:assert/strict';
import type { BrowserExportInspection } from './browserExport';
import { chooseSupportedRoute, recordExportPerformance } from './exportRoutePlanner';
import type { ExportEngineInfo } from './exportWorkflowTypes';

const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  },
});

const software: ExportEngineInfo = {
  id: 'libx264',
  label: 'Software (libx264)',
  hardware: false,
  transport: 'server',
};
const hardware: ExportEngineInfo = {
  id: 'h264_videotoolbox',
  label: 'Apple VideoToolbox',
  hardware: true,
  transport: 'server',
};
const efficient: BrowserExportInspection = { status: 'supported', issues: [], powerEfficient: true };
const compatible: BrowserExportInspection = { status: 'supported', issues: [], powerEfficient: false };
const unsupported: BrowserExportInspection = { status: 'unsupported', issues: ['webgl'], reason: '包含 WebGL 转场' };

try {
  assert.equal(chooseSupportedRoute(unsupported, hardware).route, 'server');
  assert.equal(chooseSupportedRoute(efficient, software).route, 'browser');
  assert.equal(chooseSupportedRoute(compatible, hardware).route, 'server');

  values.set('cc.exportPerformance.v1', JSON.stringify({
    'browser:webcodecs': { samples: 2, workPerMillisecond: 20 },
    'server:libx264': { samples: 2, workPerMillisecond: 40 },
  }));
  const measured = chooseSupportedRoute(efficient, software);
  assert.equal(measured.route, 'server');
  assert.equal(measured.reason, '历史实测显示本机渲染器更快');

  values.clear();
  recordExportPerformance(hardware, { width: 1920, height: 1080, frames: 30, elapsedMs: 1000 });
  const stored = JSON.parse(values.get('cc.exportPerformance.v1') ?? '{}') as Record<string, { samples: number }>;
  assert.equal(stored['server:h264_videotoolbox']?.samples, 1);
  console.log('export route planner verification passed');
} finally {
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
  else Reflect.deleteProperty(globalThis, 'localStorage');
}
