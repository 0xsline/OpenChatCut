import assert from 'node:assert/strict';
import { ASR_INFERENCE_CONTRACT } from './asr-inference-contract.ts';
import {
  isDesktopClapResponse,
  isDesktopInferenceCapabilities,
  isDesktopRhythmResponse,
  isDesktopSemanticResponse,
  parseDesktopAsrPreloadRequest,
  parseDesktopAsrRequest,
  parseDesktopClapRequest,
  parseDesktopRhythmRequest,
  parseDesktopSemanticRequest,
} from './desktop-inference.ts';
import {
  CLAP_INFERENCE_CONTRACT,
  RHYTHM_INFERENCE_CONTRACT,
  SEMANTIC_INFERENCE_CONTRACT,
} from './vector-inference-contract.ts';
import {
  preferredNativeInferenceBackend,
  preferredNativeRhythmBackend,
  resolveDesktopInferenceCapabilities,
} from '../desktop/native-inference-policy.ts';

const asrRequest = parseDesktopAsrRequest({
  requestId: 'desktop-asr-1234',
  contractId: ASR_INFERENCE_CONTRACT.id,
  sourcePath: '/media/uploads/example.mp4',
  modelId: 'onnx-community/whisper-base',
  revision: 'a'.repeat(40),
  language: 'zh',
});
assert.equal(asrRequest.contractId, ASR_INFERENCE_CONTRACT.id);
assert.throws(() => parseDesktopAsrRequest({ ...asrRequest, sourcePath: '/media/uploads/../secret.mp4' }));
assert.throws(() => parseDesktopAsrRequest({ ...asrRequest, contractId: 'stale-contract' }));
assert.throws(() => parseDesktopAsrRequest({ ...asrRequest, requestId: 'short' }));
assert.equal(parseDesktopAsrPreloadRequest({
  requestId: asrRequest.requestId,
  contractId: asrRequest.contractId,
  action: 'load',
  modelId: asrRequest.modelId,
  revision: asrRequest.revision,
}).action, 'load');
assert.throws(() => parseDesktopAsrPreloadRequest({
  requestId: asrRequest.requestId,
  contractId: asrRequest.contractId,
  action: 'load',
  modelId: asrRequest.modelId,
  revision: asrRequest.revision,
  sourcePath: asrRequest.sourcePath,
}));

const frame = { data: new Uint8ClampedArray(16), width: 2, height: 2 };
assert.equal(parseDesktopSemanticRequest({
  requestId: 'semantic-1234',
  contractId: SEMANTIC_INFERENCE_CONTRACT.id,
  action: 'embed-image',
  frame,
}).action, 'embed-image');
assert.throws(() => parseDesktopSemanticRequest({
  requestId: 'semantic-1234',
  contractId: SEMANTIC_INFERENCE_CONTRACT.id,
  action: 'embed-image',
  frame: { ...frame, data: new Uint8ClampedArray(15) },
}));
function duplicateRequest(vectorCount: number) {
  return {
    requestId: 'semantic-duplicates-1234',
    contractId: SEMANTIC_INFERENCE_CONTRACT.id,
    action: 'find-duplicates' as const,
    threshold: 0.985,
    vectors: {
      assetIds: ['asset-a'],
      assetVectorOffsets: new Uint32Array([0, vectorCount]),
      vectorValueOffsets: Uint32Array.from(
        { length: vectorCount + 1 },
        (_, index) => index * SEMANTIC_INFERENCE_CONTRACT.embeddingDimension,
      ),
      values: new Float32Array(
        vectorCount * SEMANTIC_INFERENCE_CONTRACT.embeddingDimension,
      ),
    },
  };
}
assert.equal(
  parseDesktopSemanticRequest(
    duplicateRequest(SEMANTIC_INFERENCE_CONTRACT.maxVectorsPerAsset),
  ).action,
  'find-duplicates',
);
assert.throws(() => parseDesktopSemanticRequest(
  duplicateRequest(SEMANTIC_INFERENCE_CONTRACT.maxVectorsPerAsset + 1),
), /invalid desktop semantic request/);
assert.equal(parseDesktopClapRequest({
  requestId: 'clap-embed-1234',
  contractId: CLAP_INFERENCE_CONTRACT.id,
  action: 'embed',
  samples: new Float32Array([0, 0.25, -0.25]),
  sampleRate: CLAP_INFERENCE_CONTRACT.sampleRate,
}).action, 'embed');
assert.throws(() => parseDesktopClapRequest({
  requestId: 'clap-embed-1234',
  contractId: CLAP_INFERENCE_CONTRACT.id,
  action: 'embed',
  samples: new Float32Array([Number.NaN]),
  sampleRate: CLAP_INFERENCE_CONTRACT.sampleRate,
}));

const rhythmSamples = new Float32Array(RHYTHM_INFERENCE_CONTRACT.minimumSamples);
const rhythmRequest = parseDesktopRhythmRequest({
  requestId: 'rhythm-analyze-1234',
  contractId: RHYTHM_INFERENCE_CONTRACT.id,
  action: 'analyze',
  samples: rhythmSamples,
  sampleRate: RHYTHM_INFERENCE_CONTRACT.sampleRate,
});
assert.equal(rhythmRequest.action, 'analyze');
assert.throws(() => parseDesktopRhythmRequest({ ...rhythmRequest, sampleRate: 48_000 }));
assert.throws(() => parseDesktopRhythmRequest({
  ...rhythmRequest,
  samples: new Float32Array([Number.NaN, ...new Float32Array(512)]),
}));
assert.throws(() => parseDesktopRhythmRequest({
  ...rhythmRequest,
  samples: new Float32Array(RHYTHM_INFERENCE_CONTRACT.minimumSamples - 1),
}));
const oversized = new Float32Array(RHYTHM_INFERENCE_CONTRACT.minimumSamples);
Object.defineProperty(oversized, 'length', {
  value: RHYTHM_INFERENCE_CONTRACT.sampleRate * RHYTHM_INFERENCE_CONTRACT.maxDurationSeconds + 1,
});
assert.throws(() => parseDesktopRhythmRequest({ ...rhythmRequest, samples: oversized }));
assert.throws(() => parseDesktopRhythmRequest({
  requestId: 'rhythm-load-1234',
  contractId: RHYTHM_INFERENCE_CONTRACT.id,
  action: 'load',
  modelPath: '/tmp/beat_this.onnx',
}));

assert.equal(preferredNativeInferenceBackend('win32'), 'native-cpu');
assert.equal(preferredNativeInferenceBackend('darwin'), 'native-metal');
assert.equal(preferredNativeInferenceBackend('linux'), 'native-cpu');
assert.equal(preferredNativeRhythmBackend('win32'), 'directml');
assert.equal(preferredNativeRhythmBackend('darwin'), 'coreml');
assert.equal(preferredNativeRhythmBackend('linux'), null);
const windows = resolveDesktopInferenceCapabilities({
  platform: 'win32',
  transformerRuntime: true,
  ffmpegRuntime: true,
});
assert.equal(windows.asr.preferredBackend, 'native-cpu');
assert.equal(windows.semantic.contractId, SEMANTIC_INFERENCE_CONTRACT.id);
assert.equal(windows.clap.contractId, CLAP_INFERENCE_CONTRACT.id);
assert.equal(windows.rhythm.contractId, RHYTHM_INFERENCE_CONTRACT.id);
assert.equal(windows.rhythm.preferredBackend, 'directml');
assert.equal(isDesktopInferenceCapabilities(windows), true);
const linux = resolveDesktopInferenceCapabilities({
  platform: 'linux',
  transformerRuntime: true,
  ffmpegRuntime: true,
});
assert.equal(isDesktopInferenceCapabilities(linux), true);
const noFfmpeg = resolveDesktopInferenceCapabilities({
  platform: 'darwin',
  transformerRuntime: true,
  ffmpegRuntime: false,
});
assert.equal(noFfmpeg.asr.available, false);
assert.equal(noFfmpeg.semantic.available, true);
assert.equal(noFfmpeg.clap.available, true);
assert.equal(noFfmpeg.rhythm.preferredBackend, 'coreml');
const unavailable = resolveDesktopInferenceCapabilities({
  platform: 'darwin',
  transformerRuntime: false,
  ffmpegRuntime: true,
});
assert.match(unavailable.semantic.reason ?? '', /native ONNX runtime unavailable/);
assert.equal(isDesktopInferenceCapabilities({ ...windows, semantic: { ...windows.semantic, contractId: 'old' } }), false);
assert.equal(isDesktopInferenceCapabilities({ ...windows, version: 2 }), false);

const semanticVector = Array(SEMANTIC_INFERENCE_CONTRACT.embeddingDimension).fill(0);
assert.equal(isDesktopSemanticResponse({
  requestId: 'semantic-1234',
  backend: 'native-cpu',
  result: { type: 'embedding', vector: semanticVector },
}), true);
assert.equal(isDesktopClapResponse({
  requestId: 'clap-embed-1234',
  backend: 'directml',
  result: { type: 'embedding', vector: semanticVector },
}), true);
assert.equal(isDesktopRhythmResponse({
  requestId: 'rhythm-analyze-1234',
  backend: 'coreml',
  result: {
    type: 'analysis',
    beat: new Float32Array([0, 1]),
    downbeat: new Float32Array([0, -1]),
  },
}), true);
assert.equal(isDesktopRhythmResponse({
  requestId: 'rhythm-analyze-1234',
  backend: 'coreml',
  result: {
    type: 'analysis',
    beat: new Float32Array([Number.NaN]),
    downbeat: new Float32Array([0]),
  },
}), false);

console.log('desktop-inference.verify: request boundaries and platform backend policy OK');
