export const BEAT_THIS_SAMPLE_RATE = 22_050;
export const BEAT_THIS_N_FFT = 1_024;
export const BEAT_THIS_HOP_LENGTH = 441;
export const BEAT_THIS_MEL_BINS = 128;
export const BEAT_THIS_FFT_BINS = BEAT_THIS_N_FFT / 2 + 1;
export const BEAT_THIS_CHUNK_FRAMES = 1_500;
export const BEAT_THIS_BORDER_FRAMES = 6;
export const BEAT_THIS_FPS = BEAT_THIS_SAMPLE_RATE / BEAT_THIS_HOP_LENGTH;
export const BEAT_THIS_EMPTY_LOGIT = -1_000;

export interface BeatThisFeatures {
  readonly values: Float32Array;
  readonly frames: number;
}

export interface BeatThisWindowLayout {
  readonly start: number;
  readonly frames: number;
}

export interface BeatThisWindow extends BeatThisWindowLayout {
  readonly values: Float32Array;
}

export interface BeatThisWindowLogits {
  readonly beat: Float32Array;
  readonly downbeat: Float32Array;
}

export interface BeatThisLogits {
  readonly beat: Float32Array;
  readonly downbeat: Float32Array;
}

const hannWindow = (): Float32Array => {
  const window = new Float32Array(BEAT_THIS_N_FFT);
  for (let index = 0; index < window.length; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / BEAT_THIS_N_FFT);
  }
  return window;
};

const reflectIndex = (index: number, length: number): number => {
  if (index < 0) return -index;
  if (index >= length) return 2 * length - index - 2;
  return index;
};

const bitReverse = (real: Float32Array, imaginary: Float32Array): void => {
  let target = 0;
  for (let source = 1; source < real.length; source += 1) {
    let bit = real.length >> 1;
    while (target & bit) {
      target ^= bit;
      bit >>= 1;
    }
    target ^= bit;
    if (source >= target) continue;
    [real[source], real[target]] = [real[target]!, real[source]!];
    [imaginary[source], imaginary[target]] = [imaginary[target]!, imaginary[source]!];
  }
};

const fftInPlace = (real: Float32Array, imaginary: Float32Array): void => {
  bitReverse(real, imaginary);
  for (let size = 2; size <= real.length; size *= 2) {
    const angle = (-2 * Math.PI) / size;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let offset = 0; offset < real.length; offset += size) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let index = 0; index < size / 2; index += 1) {
        const even = offset + index;
        const odd = even + size / 2;
        const oddReal = real[odd]! * twiddleReal - imaginary[odd]! * twiddleImaginary;
        const oddImaginary = real[odd]! * twiddleImaginary + imaginary[odd]! * twiddleReal;
        real[odd] = real[even]! - oddReal;
        imaginary[odd] = imaginary[even]! - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
};

const frameMagnitude = (
  samples: Float32Array,
  center: number,
  window: Float32Array,
  real: Float32Array,
  imaginary: Float32Array,
  magnitude: Float32Array,
): void => {
  const pad = BEAT_THIS_N_FFT / 2;
  for (let index = 0; index < BEAT_THIS_N_FFT; index += 1) {
    real[index] = samples[reflectIndex(center + index - pad, samples.length)]! * window[index]!;
    imaginary[index] = 0;
  }
  fftInPlace(real, imaginary);
  const scale = 1 / Math.sqrt(BEAT_THIS_N_FFT);
  for (let bin = 0; bin < BEAT_THIS_FFT_BINS; bin += 1) {
    magnitude[bin] = Math.hypot(real[bin]!, imaginary[bin]!) * scale;
  }
};

const melRanges = (filterbank: Float32Array): Int16Array => {
  const ranges = new Int16Array(BEAT_THIS_FFT_BINS * 2);
  for (let bin = 0; bin < BEAT_THIS_FFT_BINS; bin += 1) {
    let from = BEAT_THIS_MEL_BINS;
    let to = 0;
    const offset = bin * BEAT_THIS_MEL_BINS;
    for (let mel = 0; mel < BEAT_THIS_MEL_BINS; mel += 1) {
      if (filterbank[offset + mel] === 0) continue;
      from = Math.min(from, mel);
      to = mel + 1;
    }
    ranges[bin * 2] = from;
    ranges[bin * 2 + 1] = to;
  }
  return ranges;
};

const projectFrame = (
  magnitude: Float32Array,
  filterbank: Float32Array,
  ranges: Int16Array,
  features: Float32Array,
  frame: number,
): void => {
  const output = frame * BEAT_THIS_MEL_BINS;
  for (let bin = 0; bin < BEAT_THIS_FFT_BINS; bin += 1) {
    const magnitudeValue = magnitude[bin]!;
    const weights = bin * BEAT_THIS_MEL_BINS;
    const from = ranges[bin * 2]!;
    const to = ranges[bin * 2 + 1]!;
    for (let mel = from; mel < to; mel += 1) {
      features[output + mel] += magnitudeValue * filterbank[weights + mel]!;
    }
  }
  for (let mel = 0; mel < BEAT_THIS_MEL_BINS; mel += 1) {
    features[output + mel] = Math.log1p(1_000 * features[output + mel]!);
  }
};

const validateFilterbank = (filterbank: Float32Array): void => {
  if (filterbank.length !== BEAT_THIS_FFT_BINS * BEAT_THIS_MEL_BINS) {
    throw new Error(`Invalid Beat This filterbank length: ${filterbank.length}`);
  }
};

export function beatThisFrameCount(samples: Float32Array): number {
  if (samples.length <= BEAT_THIS_N_FFT / 2) {
    throw new Error('Beat This audio must contain more than 512 samples for reflect padding');
  }
  return Math.floor(samples.length / BEAT_THIS_HOP_LENGTH) + 1;
}

const preprocessFrames = (
  samples: Float32Array,
  filterbank: Float32Array,
  sourceStart: number,
  count: number,
  values: Float32Array,
  outputStart: number,
  onProgress?: (progress: number) => void,
): void => {
  const window = hannWindow();
  const real = new Float32Array(BEAT_THIS_N_FFT);
  const imaginary = new Float32Array(BEAT_THIS_N_FFT);
  const magnitude = new Float32Array(BEAT_THIS_FFT_BINS);
  const ranges = melRanges(filterbank);
  for (let offset = 0; offset < count; offset += 1) {
    const source = sourceStart + offset;
    frameMagnitude(samples, source * BEAT_THIS_HOP_LENGTH, window, real, imaginary, magnitude);
    projectFrame(magnitude, filterbank, ranges, values, outputStart + offset);
    if ((offset & 63) === 63 || offset === count - 1) onProgress?.((offset + 1) / count);
  }
};

export function preprocessBeatThis(
  samples: Float32Array,
  filterbank: Float32Array,
  onProgress?: (progress: number) => void,
): BeatThisFeatures {
  const frames = beatThisFrameCount(samples);
  validateFilterbank(filterbank);
  const values = new Float32Array(frames * BEAT_THIS_MEL_BINS);
  preprocessFrames(samples, filterbank, 0, frames, values, 0, onProgress);
  return { values, frames };
}

const beatThisWindowFrames = (fullFrames: number): number => {
  const stride = BEAT_THIS_CHUNK_FRAMES - 2 * BEAT_THIS_BORDER_FRAMES;
  return fullFrames > stride ? BEAT_THIS_CHUNK_FRAMES : fullFrames + 2 * BEAT_THIS_BORDER_FRAMES;
};

export function preprocessBeatThisWindow(
  samples: Float32Array,
  filterbank: Float32Array,
  start: number,
): BeatThisWindow {
  const fullFrames = beatThisFrameCount(samples);
  validateFilterbank(filterbank);
  if (!Number.isSafeInteger(start)) throw new Error('Beat This window start must be an integer');
  const frames = beatThisWindowFrames(fullFrames);
  const values = new Float32Array(frames * BEAT_THIS_MEL_BINS);
  const sourceStart = Math.max(start, 0);
  const sourceEnd = Math.min(start + frames, fullFrames);
  const count = Math.max(0, sourceEnd - sourceStart);
  preprocessFrames(samples, filterbank, sourceStart, count, values, sourceStart - start);
  return { start, frames, values };
}

export function beatThisWindowStarts(frames: number): number[] {
  if (!Number.isSafeInteger(frames) || frames <= 0) throw new Error('Beat This frame count must be positive');
  const stride = BEAT_THIS_CHUNK_FRAMES - 2 * BEAT_THIS_BORDER_FRAMES;
  const starts: number[] = [];
  for (let start = -BEAT_THIS_BORDER_FRAMES; start < frames - BEAT_THIS_BORDER_FRAMES; start += stride) {
    starts.push(start);
  }
  if (frames > stride) starts[starts.length - 1] = frames - (BEAT_THIS_CHUNK_FRAMES - BEAT_THIS_BORDER_FRAMES);
  return starts;
}

export function createBeatThisWindow(features: BeatThisFeatures, start: number): BeatThisWindow {
  if (features.values.length !== features.frames * BEAT_THIS_MEL_BINS) {
    throw new Error('Beat This feature shape does not match its frame count');
  }
  const frames = beatThisWindowFrames(features.frames);
  const values = new Float32Array(frames * BEAT_THIS_MEL_BINS);
  for (let frame = 0; frame < frames; frame += 1) {
    const source = start + frame;
    if (source < 0 || source >= features.frames) continue;
    const from = source * BEAT_THIS_MEL_BINS;
    values.set(features.values.subarray(from, from + BEAT_THIS_MEL_BINS), frame * BEAT_THIS_MEL_BINS);
  }
  return { start, frames, values };
}

export function splitBeatThisFeatures(features: BeatThisFeatures): BeatThisWindow[] {
  return beatThisWindowStarts(features.frames).map((start) => createBeatThisWindow(features, start));
}

export function mergeBeatThisLogits(
  windows: readonly BeatThisWindowLayout[],
  predictions: readonly BeatThisWindowLogits[],
  fullFrames: number,
): BeatThisLogits {
  if (windows.length !== predictions.length) throw new Error('Beat This window/prediction count mismatch');
  const beat = new Float32Array(fullFrames).fill(BEAT_THIS_EMPTY_LOGIT);
  const downbeat = new Float32Array(fullFrames).fill(BEAT_THIS_EMPTY_LOGIT);
  for (let index = windows.length - 1; index >= 0; index -= 1) {
    const window = windows[index]!;
    const prediction = predictions[index]!;
    if (prediction.beat.length !== window.frames || prediction.downbeat.length !== window.frames) {
      throw new Error(`Beat This prediction shape mismatch at window ${index}`);
    }
    for (let frame = BEAT_THIS_BORDER_FRAMES; frame < window.frames - BEAT_THIS_BORDER_FRAMES; frame += 1) {
      const target = window.start + frame;
      if (target < 0 || target >= fullFrames) continue;
      beat[target] = prediction.beat[frame]!;
      downbeat[target] = prediction.downbeat[frame]!;
    }
  }
  return { beat, downbeat };
}
