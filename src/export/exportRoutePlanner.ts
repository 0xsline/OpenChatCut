import { inspectBrowserExport, isAbortError, type BrowserExportInspection, type BrowserExportOptions } from './browserExport';
import type { ExportEngineInfo } from './exportWorkflowTypes';

const PERFORMANCE_STORAGE_KEY = 'cc.exportPerformance.v1';
const MIN_SAMPLE_MS = 250;
const MAX_PERFORMANCE_SAMPLES = 20;
const PREVIOUS_SAMPLE_WEIGHT = 0.7;
const CURRENT_SAMPLE_WEIGHT = 1 - PREVIOUS_SAMPLE_WEIGHT;


interface EnginePerformance {
  samples: number;
  workPerMillisecond: number;
}

type PerformanceStore = Record<string, EnginePerformance>;

export interface ExportRoutePlan {
  route: 'browser' | 'server';
  engine: ExportEngineInfo;
  browserEngine: ExportEngineInfo;
  serverEngine: ExportEngineInfo;
  browser: BrowserExportInspection;
  reason: string;
}

interface ServerCapabilities {
  h264?: ExportEngineInfo;
  renderConcurrency?: number;
}

function browserEngine(powerEfficient?: boolean): ExportEngineInfo {
  return {
    id: 'webcodecs',
    label: powerEfficient ? 'WebCodecs · 硬件加速' : 'WebCodecs · 本机编码',
    hardware: powerEfficient === true,
    transport: 'browser',
  };
}

function unknownServerEngine(): ExportEngineInfo {
  return { id: 'local-renderer', label: '本机兼容渲染', hardware: false, transport: 'server' };
}

async function loadServerCapabilities(signal?: AbortSignal): Promise<ServerCapabilities> {
  try {
    const response = await fetch('/export/capabilities', { signal });
    if (!response.ok) return {};
    return await response.json() as ServerCapabilities;
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {};
  }
}

async function inspectBrowser(options: BrowserExportOptions): Promise<BrowserExportInspection> {
  try {
    return await inspectBrowserExport(options);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      status: 'unsupported',
      reason: error instanceof Error ? error.message : '浏览器快导失败',
      issues: [],
    };
  }
}

function loadPerformance(): PerformanceStore {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(PERFORMANCE_STORAGE_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => {
      if (!value || typeof value !== 'object') return false;
      const candidate = value as Partial<EnginePerformance>;
      return Number.isFinite(candidate.samples) && Number.isFinite(candidate.workPerMillisecond);
    })) as PerformanceStore;
  } catch {
    return {};
  }
}

function performanceKey(engine: ExportEngineInfo): string {
  return `${engine.transport}:${engine.id}`;
}

function measuredRoute(browser: ExportEngineInfo, server: ExportEngineInfo): 'browser' | 'server' | null {
  const store = loadPerformance();
  const browserSample = store[performanceKey(browser)];
  const serverSample = store[performanceKey(server)];
  if (!browserSample?.samples || !serverSample?.samples) return null;
  return browserSample.workPerMillisecond >= serverSample.workPerMillisecond ? 'browser' : 'server';
}

export function chooseSupportedRoute(browser: BrowserExportInspection, server: ExportEngineInfo) {
  const web = browserEngine(browser.status === 'supported' ? browser.powerEfficient : undefined);
  if (browser.status === 'unsupported') {
    return { route: 'server' as const, engine: server, reason: browser.reason };
  }
  const measured = measuredRoute(web, server);
  if (measured === 'browser') return { route: measured, engine: web, reason: '历史实测显示浏览器路径更快' };
  if (measured === 'server') return { route: measured, engine: server, reason: '历史实测显示本机渲染器更快' };
  if (browser.powerEfficient) return { route: 'browser' as const, engine: web, reason: '浏览器确认支持硬件高效编码' };
  if (server.hardware) return { route: 'server' as const, engine: server, reason: '检测到本机硬件编码器' };
  return { route: 'browser' as const, engine: web, reason: '浏览器兼容且无需额外渲染进程' };
}

export async function planVideoExportRoute(options: BrowserExportOptions): Promise<ExportRoutePlan> {
  const [browser, capabilities] = await Promise.all([
    inspectBrowser(options),
    loadServerCapabilities(options.signal),
  ]);
  const server = options.codec === 'h264' ? capabilities.h264 ?? unknownServerEngine() : unknownServerEngine();
  const browserEngineInfo = browserEngine(browser.status === 'supported' ? browser.powerEfficient : undefined);
  // ProRes mezzanine is Remotion/server-only (not WebCodecs).
  if (options.codec === 'prores') {
    const mezzanine = {
      id: 'prores-mezzanine',
      label: 'ProRes 422 HQ · 本机母带',
      hardware: false,
      transport: 'server' as const,
    };
    return {
      browser,
      browserEngine: browserEngineInfo,
      serverEngine: mezzanine,
      route: 'server',
      engine: mezzanine,
      reason: 'ProRes 母带仅支持本机渲染',
    };
  }
  return {
    browser,
    browserEngine: browserEngineInfo,
    serverEngine: server,
    ...chooseSupportedRoute(browser, server),
  };
}

export function recordExportPerformance(engine: ExportEngineInfo, metrics: {
  width: number;
  height: number;
  frames: number;
  elapsedMs: number;
}): void {
  if (metrics.elapsedMs < MIN_SAMPLE_MS || metrics.frames < 1) return;
  const key = performanceKey(engine);
  const store = loadPerformance();
  const previous = store[key];
  const current = metrics.width * metrics.height * metrics.frames / metrics.elapsedMs;
  store[key] = {
    samples: Math.min(MAX_PERFORMANCE_SAMPLES, (previous?.samples ?? 0) + 1),
    workPerMillisecond: previous
      ? previous.workPerMillisecond * PREVIOUS_SAMPLE_WEIGHT + current * CURRENT_SAMPLE_WEIGHT
      : current,
  };
  try {
    localStorage.setItem(PERFORMANCE_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Performance history is optional; export routing still uses live capability probes.
  }
}
