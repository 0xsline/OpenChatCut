import assert from 'node:assert/strict';
import { normalizeDesktopHardwareProfile } from './native-hardware-profile.ts';

const hardware = normalizeDesktopHardwareProfile({
  driverVendor: 'NVIDIA',
  driverVersion: '555.42',
  auxAttributes: { softwareRendering: false },
  gpuDevice: [
    { active: true, vendorId: 0x10de, deviceId: 0x2684, deviceString: 'RTX fixture' },
    { active: false, vendorId: 0x8086, deviceId: 0x46a6 },
    { active: true, vendorId: -1 },
  ],
}, {
  platform: 'linux',
  arch: 'x64',
  cpuModel: 'Fixture CPU',
  logicalCores: 16,
  totalMemoryBytes: 32 * 1024 ** 3,
  hardwareAcceleration: true,
  graphicsFeatures: { gpu_compositing: 'enabled', invalid: 42 },
});

assert.equal(hardware.platform, 'linux');
assert.equal(hardware.cpu.logicalCores, 16);
assert.equal(hardware.hardwareAcceleration, true);
assert.deepEqual(hardware.gpus.map((gpu) => gpu.vendor), ['nvidia', 'intel', 'unknown']);
assert.equal(hardware.gpus[0]?.description, 'RTX fixture');
assert.deepEqual(hardware.graphicsFeatures, { gpu_compositing: 'enabled' });
assert.equal(hardware.driverVersion, '555.42');

const software = normalizeDesktopHardwareProfile({
  auxAttributes: { softwareRendering: true },
  gpuDevice: [{ active: true, vendorId: 0x1002, deviceId: 1 }],
}, {
  platform: 'win32',
  arch: 'x64',
  cpuModel: 'Fixture CPU',
  logicalCores: 8,
  totalMemoryBytes: 16 * 1024 ** 3,
  hardwareAcceleration: true,
  graphicsFeatures: {},
});

assert.equal(software.hardwareAcceleration, false);
assert.equal(software.gpus[0]?.vendor, 'amd');

console.log('native-hardware-profile.verify: GPU/CPU normalization passed');
