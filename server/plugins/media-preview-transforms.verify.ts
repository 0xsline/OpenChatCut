import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computePeaks } from './media-preview-transforms.ts';

const sampleRate = 8_000;
const headerSize = 44;

async function writePulseWave(file: string, sampleCount: number, pulses: number[]): Promise<void> {
  const pcmBytes = sampleCount * 2;
  const wave = Buffer.alloc(headerSize + pcmBytes);
  wave.write('RIFF', 0);
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20); // PCM
  wave.writeUInt16LE(1, 22); // mono
  wave.writeUInt32LE(sampleRate, 24);
  wave.writeUInt32LE(sampleRate * 2, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(pcmBytes, 40);
  for (const sample of pulses) wave.writeInt16LE(24_576, headerSize + sample * 2);
  await writeFile(file, wave);
}

const temp = await mkdtemp(join(tmpdir(), 'openchatcut-waveform-verify-'));
try {
  const file = join(temp, 'pulses.wav');
  const signal = new AbortController().signal;
  // 121 seconds exceeds the old point cap. 1,201 seconds triggers downsampling with the new cap.
  for (const [duration, samplesPerBin] of [[121, 80], [1_201, 81]] as const) {
    const sampleCount = duration * sampleRate;
    const pulseSamples = [12_345, Math.floor(sampleCount / 2) + 789, sampleCount - 13];
    await writePulseWave(file, sampleCount, pulseSamples);
    const { peaks, peaksPerSecond } = await computePeaks(file, duration * 1000, signal);
    assert.equal(peaksPerSecond, sampleRate / samplesPerBin);
    assert.equal(peaks.length, Math.ceil(sampleCount / samplesPerBin));
    assert.deepEqual(
      peaks.flatMap((peak, index) => peak > 0.7 ? [index] : []),
      pulseSamples.map((sample) => Math.floor(sample / samplesPerBin)),
    );
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}

console.log('media-preview-transforms.verify: waveform peak timestamps follow the decoded PCM');
