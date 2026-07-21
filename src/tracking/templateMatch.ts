import type { GrayTemplate, MatchResult } from './types';

const MIN_VARIANCE = 1e-4;

export function rgbaToGrayscale(image: ImageData): Uint8Array {
  const gray = new Uint8Array(image.width * image.height);
  for (let pixel = 0, rgba = 0; pixel < gray.length; pixel += 1, rgba += 4) {
    gray[pixel] = Math.round(
      image.data[rgba] * 0.299
      + image.data[rgba + 1] * 0.587
      + image.data[rgba + 2] * 0.114,
    );
  }
  return gray;
}

function sampleOffsets(width: number, height: number, step: number): Uint32Array {
  const values: number[] = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) values.push(y * width + x);
  }
  return Uint32Array.from(values);
}

export function createGrayTemplate(
  frame: Uint8Array,
  frameWidth: number,
  x: number,
  y: number,
  width: number,
  height: number,
): GrayTemplate {
  const sampleStep = Math.max(1, Math.ceil(Math.max(width, height) / 32));
  const offsets = sampleOffsets(width, height, sampleStep);
  const samples = new Float32Array(offsets.length);
  let sum = 0;
  for (let index = 0; index < offsets.length; index += 1) {
    const local = offsets[index];
    const value = frame[(y + Math.floor(local / width)) * frameWidth + x + (local % width)];
    samples[index] = value;
    sum += value;
  }
  const mean = sum / samples.length;
  let squared = 0;
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] -= mean;
    squared += samples[index] * samples[index];
  }
  return { width, height, sampleStep, offsets, centered: samples, norm: Math.sqrt(squared) };
}

function scoreAt(
  frame: Uint8Array,
  frameWidth: number,
  template: GrayTemplate,
  x: number,
  y: number,
): number {
  let sum = 0;
  let squared = 0;
  let dot = 0;
  const count = template.offsets.length;
  for (let index = 0; index < count; index += 1) {
    const local = template.offsets[index];
    const sampleY = Math.floor(local / template.width);
    const value = frame[(y + sampleY) * frameWidth + x + (local % template.width)];
    sum += value;
    squared += value * value;
    dot += template.centered[index] * value;
  }
  const candidateVariance = squared - (sum * sum) / count;
  if (template.norm < MIN_VARIANCE || candidateVariance < MIN_VARIANCE) return -1;
  return dot / (template.norm * Math.sqrt(candidateVariance));
}

function searchRange(center: number, radius: number, limit: number): [number, number] {
  return [Math.max(0, center - radius), Math.min(limit, center + radius)];
}

function search(
  frame: Uint8Array,
  frameWidth: number,
  template: GrayTemplate,
  rangeX: [number, number],
  rangeY: [number, number],
  stride: number,
): MatchResult {
  let best: MatchResult = { x: rangeX[0], y: rangeY[0], confidence: -1 };
  for (let y = rangeY[0]; y <= rangeY[1]; y += stride) {
    for (let x = rangeX[0]; x <= rangeX[1]; x += stride) {
      const confidence = scoreAt(frame, frameWidth, template, x, y);
      if (confidence > best.confidence) best = { x, y, confidence };
    }
  }
  return best;
}

export function findBestMatch(
  frame: Uint8Array,
  frameWidth: number,
  frameHeight: number,
  template: GrayTemplate,
  predictedX: number,
  predictedY: number,
  radius: number,
): MatchResult {
  const maxX = Math.max(0, frameWidth - template.width);
  const maxY = Math.max(0, frameHeight - template.height);
  const coarse = search(
    frame,
    frameWidth,
    template,
    searchRange(Math.round(predictedX), radius, maxX),
    searchRange(Math.round(predictedY), radius, maxY),
    4,
  );
  return search(
    frame,
    frameWidth,
    template,
    searchRange(coarse.x, 4, maxX),
    searchRange(coarse.y, 4, maxY),
    1,
  );
}
