import assert from 'node:assert/strict';
import { Tensor } from '@huggingface/transformers';
import {
  patchWhisperWordTimestampModel,
  type WhisperTimestampModel,
} from './whisper-word-timestamps';

const prefix = [50258n, 50260n, 50359n, 50363n];
const sequences = new Tensor('int64', [...prefix, 11n, 12n, 50257n], [1, 7]);
const attentionData = new Float32Array(24);
attentionData.set([1, 1, 1, 1], 0);
attentionData.set([1, 1, 1, 1], 4);
attentionData.set([1, 1, 1, 1], 8);
attentionData.set([1, 1, 1, 1], 12);
attentionData.set([10, 0, 0, 0], 16);
attentionData.set([0, 0, 10, 0], 20);
const attention = new Tensor('float32', attentionData, [1, 1, 6, 4]);
let fullTimestampShape: number[] = [];

const model: WhisperTimestampModel = {
  config: { decoder_layers: 1, median_filter_width: 1 },
  generation_config: {
    decoder_start_token_id: 50258,
    no_timestamps_token_id: 50363,
    lang_to_id: { '<|zh|>': 50260 },
    task_to_id: { transcribe: 50359 },
  },
  async generate() {
    const output = { sequences, cross_attentions: [[attention]], token_timestamps: sequences };
    output.token_timestamps = this._extract_token_timestamps(output, [[0, 0]], 4);
    fullTimestampShape = output.token_timestamps.dims;
    return output;
  },
  _extract_token_timestamps() {
    assert.fail('prefix inputs must use the patched DTW path');
  },
};

patchWhisperWordTimestampModel(model);
const output = await model.generate({ return_token_timestamps: true });
if (output instanceof Tensor || !output.token_timestamps) assert.fail('expected Whisper word timestamp output');
const times = output.token_timestamps.tolist()[0] as number[];
assert.deepEqual(fullTimestampShape, [1, 7], 'internal timestamps retain prefix/content/EOS shape');
assert.deepEqual(output.sequences.tolist(), [[11n, 12n, 50257n]]);
assert.equal(times.length, 3, 'prefix strip keeps content and EOS timestamps aligned');
assert.ok(times[1]! >= times[0]!, 'word timestamps remain monotonic');
assert.equal(times[2], times[1], 'EOS duplicates the final aligned time');

console.log('whisper-word-timestamps.verify: ok');
