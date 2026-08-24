import {
  Tensor,
  cat,
  dynamic_time_warping,
  mean,
  medianFilter,
  stack,
  std_mean,
} from '@huggingface/transformers';

type WhisperOutput = {
  sequences: Tensor;
  cross_attentions?: Tensor[][];
  token_timestamps?: Tensor;
};
type WhisperGenerationConfig = {
  decoder_start_token_id?: number;
  no_timestamps_token_id?: number;
  lang_to_id?: Record<string, number>;
  task_to_id?: Record<string, number>;
};

export interface WhisperTimestampModel {
  config: { decoder_layers: number; median_filter_width?: number };
  generation_config?: WhisperGenerationConfig;
  generate: (options: Record<string, unknown>) => Promise<WhisperOutput | Tensor>;
  _extract_token_timestamps: (
    output: WhisperOutput,
    heads: number[][],
    numFrames?: number | null,
    timePrecision?: number,
  ) => Tensor;
}

const PATCHED = Symbol('openchatcut-whisper-word-timestamps');
type IndexedTensor = Tensor & { readonly [index: number]: Tensor };

function tensorAt(tensor: Tensor, index: number): Tensor {
  return (tensor as IndexedTensor)[index]!;
}

function prefixLength(sequence: Tensor, config: WhisperGenerationConfig | undefined): number {
  const tokens = sequence.tolist()[0] as bigint[] | undefined;
  if (!tokens?.length || tokens[0] !== BigInt(config?.decoder_start_token_id ?? -1)) return 0;
  const special = new Set([
    ...Object.values(config?.lang_to_id ?? {}),
    ...Object.values(config?.task_to_id ?? {}),
    config?.no_timestamps_token_id,
  ].filter((id): id is number => typeof id === 'number').map(BigInt));
  let length = 1;
  while (length < tokens.length && special.has(tokens[length]!)) length += 1;
  return length;
}

function alignmentWeights(
  model: WhisperTimestampModel,
  output: WhisperOutput & { cross_attentions: Tensor[][] },
  heads: number[][],
  numFrames?: number | null,
): Tensor {
  const layers = Array.from({ length: model.config.decoder_layers }, (_, index) => (
    cat(output.cross_attentions.map((step) => step[index]!), 2)
  ));
  return stack(heads.map(([layer, head]) => {
    const attention = layers[layer];
    if (!attention) throw new Error(`Whisper alignment layer ${layer} is unavailable`);
    return numFrames
      ? attention.slice(null, head, null, [0, numFrames])
      : attention.slice(null, head);
  })).transpose(1, 0, 2, 3);
}

function smoothWeights(weights: Tensor, width: number): Tensor {
  const [std, calculatedMean] = std_mean(weights, -2, 0, true);
  const smoothed = weights.clone();
  for (let batch = 0; batch < smoothed.dims[0]!; batch += 1) {
    const batchWeights = tensorAt(smoothed, batch);
    const batchStd = tensorAt(std, batch);
    const batchMean = tensorAt(calculatedMean, batch);
    for (let head = 0; head < batchWeights.dims[0]!; head += 1) {
      const rows = tensorAt(batchWeights, head);
      const stdData = tensorAt(tensorAt(batchStd, head), 0).data as Float32Array;
      const meanData = tensorAt(tensorAt(batchMean, head), 0).data as Float32Array;
      for (let row = 0; row < rows.dims[0]!; row += 1) {
        const data = tensorAt(rows, row).data as Float32Array;
        for (let frame = 0; frame < data.length; frame += 1) {
          data[frame] = (data[frame]! - meanData[frame]!) / stdData[frame]!;
        }
        data.set(medianFilter(data, width) as Float32Array);
      }
    }
  }
  return smoothed;
}

function jumpTimes(matrix: Tensor, precision: number): number[] {
  const [textIndices, timeIndices] = dynamic_time_warping(matrix.neg().squeeze_(0).tolist());
  const jumps = [1, ...textIndices.slice(1).map((value, index) => value - textIndices[index]!)];
  return jumps.flatMap((jump, index) => jump ? [timeIndices[index]! * precision] : []);
}

function extractTimestamps(
  model: WhisperTimestampModel,
  output: WhisperOutput & { cross_attentions: Tensor[][] },
  heads: number[][],
  prefix: number,
  numFrames?: number | null,
  precision = 0.02,
): Tensor {
  const weights = alignmentWeights(model, output, heads, numFrames);
  const smoothed = smoothWeights(weights, model.config.median_filter_width ?? 7);
  const cropped = smoothed.slice(null, null, [prefix, smoothed.dims[2]!], null);
  const matrices = mean(cropped, 1);
  const [batchSize, sequenceLength] = output.sequences.dims;
  const timestamps = new Tensor(
    'float32',
    new Float32Array(batchSize! * sequenceLength!),
    output.sequences.dims,
  );
  for (let batch = 0; batch < batchSize!; batch += 1) {
    const aligned = jumpTimes(tensorAt(matrices, batch), precision);
    const padded = [...new Array<number>(prefix).fill(0), ...aligned];
    if (aligned.length) padded.push(aligned.at(-1)!);
    (tensorAt(timestamps, batch).data as Float32Array).set(padded);
  }
  return timestamps;
}

function cropResult(output: WhisperOutput, prefix: number): WhisperOutput {
  if (!prefix || !output.token_timestamps) return output;
  const end = output.sequences.dims.at(-1)!;
  return {
    ...output,
    sequences: output.sequences.slice(null, [prefix, end]),
    token_timestamps: output.token_timestamps.slice(null, [prefix, end]),
  };
}

/** Backport the Whisper prefix-alignment fix while the app remains on transformers.js 3.8.1. */
export function patchWhisperWordTimestampModel(model: WhisperTimestampModel): void {
  const patched = model as WhisperTimestampModel & { [PATCHED]?: true };
  if (patched[PATCHED]) return;
  const originalExtract = model._extract_token_timestamps.bind(model);
  model._extract_token_timestamps = (output, heads, numFrames, precision) => {
    const prefix = prefixLength(output.sequences, model.generation_config);
    if (!prefix || !output.cross_attentions) {
      return originalExtract(output, heads, numFrames, precision);
    }
    return extractTimestamps(model, { ...output, cross_attentions: output.cross_attentions }, heads, prefix, numFrames, precision);
  };
  const generate = model.generate.bind(model);
  model.generate = async (options) => {
    const output = await generate(options);
    if (output instanceof Tensor || !output.token_timestamps) return output;
    return cropResult(output, prefixLength(output.sequences, model.generation_config));
  };
  patched[PATCHED] = true;
}
