import { cpus, totalmem } from 'node:os';
import type { App } from 'electron';
import type {
  DesktopGpuDevice,
  DesktopGpuVendor,
  DesktopHardwareCapabilities,
} from '../shared/desktop-inference.ts';

const MAX_GPU_DEVICES = 16;
const MAX_FEATURES = 64;

type ElectronGpuProbe = Pick<
  App,
  'getGPUFeatureStatus' | 'getGPUInfo' | 'isHardwareAccelerationEnabled'
>;

interface HardwareHostSnapshot {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly cpuModel: string;
  readonly logicalCores: number;
  readonly totalMemoryBytes: number;
  readonly hardwareAcceleration: boolean;
  readonly graphicsFeatures: unknown;
}

function supportedPlatform(platform: NodeJS.Platform): DesktopHardwareCapabilities['platform'] {
  return platform === 'darwin' || platform === 'win32' || platform === 'linux'
    ? platform
    : 'unsupported';
}

function gpuVendor(vendorId: number | undefined): DesktopGpuVendor {
  if (vendorId === 0x10de) return 'nvidia';
  if (vendorId === 0x1002 || vendorId === 0x1022) return 'amd';
  if (vendorId === 0x8086) return 'intel';
  if (vendorId === 0x106b) return 'apple';
  if (vendorId === 0x1414) return 'microsoft';
  return 'unknown';
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function shortText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    ? value
    : undefined;
}

function gpuDevices(value: unknown): DesktopGpuDevice[] {
  if (typeof value !== 'object' || value === null) return [];
  const devices = Reflect.get(value, 'gpuDevice');
  if (!Array.isArray(devices)) return [];
  return devices.slice(0, MAX_GPU_DEVICES).flatMap((entry): DesktopGpuDevice[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const vendorId = integer(Reflect.get(entry, 'vendorId'));
    const deviceId = integer(Reflect.get(entry, 'deviceId'));
    return [{
      active: Reflect.get(entry, 'active') === true,
      vendor: gpuVendor(vendorId),
      ...(vendorId === undefined ? {} : { vendorId }),
      ...(deviceId === undefined ? {} : { deviceId }),
      ...(shortText(Reflect.get(entry, 'deviceString')) ? {
        description: shortText(Reflect.get(entry, 'deviceString')),
      } : {}),
    }];
  });
}

function graphicsFeatures(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {};
  return Object.fromEntries(Object.entries(value).slice(0, MAX_FEATURES)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

export function normalizeDesktopHardwareProfile(
  gpuInfo: unknown,
  host: HardwareHostSnapshot,
): DesktopHardwareCapabilities {
  const info = typeof gpuInfo === 'object' && gpuInfo !== null ? gpuInfo : {};
  const aux = Reflect.get(info, 'auxAttributes');
  const softwareRendering = typeof aux === 'object' && aux !== null
    && Reflect.get(aux, 'softwareRendering') === true;
  return {
    platform: supportedPlatform(host.platform),
    arch: host.arch,
    cpu: {
      model: host.cpuModel.slice(0, 256),
      logicalCores: Math.max(1, integer(host.logicalCores) ?? 1),
      totalMemoryBytes: integer(host.totalMemoryBytes) ?? 0,
    },
    hardwareAcceleration: host.hardwareAcceleration && !softwareRendering,
    gpus: gpuDevices(info),
    graphicsFeatures: graphicsFeatures(host.graphicsFeatures),
    ...(shortText(Reflect.get(info, 'driverVendor')) ? {
      driverVendor: shortText(Reflect.get(info, 'driverVendor')),
    } : {}),
    ...(shortText(Reflect.get(info, 'driverVersion')) ? {
      driverVersion: shortText(Reflect.get(info, 'driverVersion')),
    } : {}),
  };
}

export async function detectDesktopHardwareProfile(
  electronApp: ElectronGpuProbe,
): Promise<DesktopHardwareCapabilities> {
  const processors = cpus();
  let gpuInfo: unknown = {};
  try {
    gpuInfo = await electronApp.getGPUInfo('complete');
  } catch {
    // Electron rejects when both hardware and software GPU implementations are disabled.
  }
  return normalizeDesktopHardwareProfile(gpuInfo, {
    platform: process.platform,
    arch: process.arch,
    cpuModel: processors[0]?.model ?? process.arch,
    logicalCores: processors.length || 1,
    totalMemoryBytes: totalmem(),
    hardwareAcceleration: electronApp.isHardwareAccelerationEnabled(),
    graphicsFeatures: electronApp.getGPUFeatureStatus(),
  });
}
