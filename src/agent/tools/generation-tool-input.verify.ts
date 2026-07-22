import assert from 'node:assert/strict';
import { buildSubmitImageArgs, buildSubmitMusicArgs, buildSubmitVideoArgs, buildSubmitVoiceArgs, shouldAddImageToTimeline } from './generate-tool-input';

assert.equal(shouldAddImageToTimeline({}), true);
assert.equal(shouldAddImageToTimeline({ addToTimeline: false }), false);

const defaultModel = buildSubmitImageArgs({
  prompt: 'a cat',
  name: 'cat',
  promptOptimizer: true,
});
assert.equal(defaultModel.model, undefined);
assert.equal(defaultModel.promptOptimizer, undefined, 'default gpt model must not receive MiniMax-only options');

const gpt = buildSubmitImageArgs({
  model: 'gpt-image-2',
  prompt: 'a dog',
  name: 'dog',
  promptOptimizer: false,
  seed: 7,
  background: 'transparent',
});
assert.equal(gpt.promptOptimizer, undefined, 'explicit gpt model must not receive MiniMax-only options');
assert.equal(gpt.seed, undefined, 'explicit gpt model must not receive MiniMax seed');
assert.equal(gpt.background, 'transparent');

const minimax = buildSubmitImageArgs({
  model: 'image-01',
  prompt: 'matte bottle',
  name: 'bottle',
  promptOptimizer: false,
  background: 'transparent',
  quality: 'high',
});
assert.equal(minimax.promptOptimizer, false, 'MiniMax literal-prompt option must be preserved');
assert.equal(minimax.background, undefined, 'MiniMax must not receive GPT-only options');
assert.equal(minimax.quality, undefined, 'MiniMax must not receive GPT quality');

const nano = buildSubmitImageArgs({
  model: 'nano-banana', prompt: 'reference collage', name: 'collage', imageSize: '2K',
  width: 1024, height: 1024, promptOptimizer: true, quality: 'high',
});
assert.equal(nano.imageSize, '2K');
assert.equal(nano.width, undefined, 'Nano Banana must not receive unsupported custom dimensions');
assert.equal(nano.promptOptimizer, undefined);

const inflatedDefaults = buildSubmitImageArgs({
  model: 'gpt-image-2', prompt: 'triangle', name: 'triangle', aspectRatio: '1:1', imageSize: '1K',
  width: 1024, height: 1024, referenceAssetIds: [], maskAssetId: '', inputFidelity: 'low',
  outputFormat: 'png', outputCompression: 100, seed: 0, promptOptimizer: false,
});
assert.equal(inflatedDefaults.width, undefined, 'aspectRatio wins over Agent-invented custom dimensions');
assert.equal(inflatedDefaults.height, undefined);
assert.equal(inflatedDefaults.maskAssetId, undefined, 'empty optional asset ids are removed');
assert.equal(inflatedDefaults.inputFidelity, undefined, 'input fidelity is removed without references');
assert.equal(inflatedDefaults.outputCompression, undefined, 'PNG does not receive JPEG/WebP compression');
assert.equal(inflatedDefaults.seed, undefined);
assert.equal(inflatedDefaults.promptOptimizer, undefined);

const hailuo = buildSubmitVideoArgs({
  model: 'hailuo', prompt: 'camera orbit', durationSeconds: 6, ratio: '16:9', resolution: '720p',
  refImages: [], mode: 'std', promptOptimizer: false, generateAudio: true, seed: 4,
});
assert.equal(hailuo.ratio, undefined, 'Hailuo must not receive a generic ratio default');
assert.equal(hailuo.mode, undefined, 'Hailuo must not receive Kling mode');
assert.equal(hailuo.generateAudio, undefined, 'Hailuo must not receive Seedance controls');
assert.equal(hailuo.promptOptimizer, false);

const seedance = buildSubmitVideoArgs({
  model: 'seedance2', prompt: 'wide shot', durationSeconds: 5, ratio: '16:9',
  refImages: ['', '  '], promptOptimizer: false, fastPretreatment: false, mode: 'std',
});
assert.equal(seedance.refImages, undefined, 'blank reference defaults are removed');
assert.equal(seedance.promptOptimizer, undefined, 'Seedance must not receive MiniMax controls');
assert.equal(seedance.mode, undefined, 'Seedance must not receive Kling mode');

const minimaxMusic = buildSubmitMusicArgs({
  provider: 'minimax', mode: 't2m', prompt: 'ambient', isInstrumental: true,
  count: 2, stream: false, styles: ['ambient'], referenceAssetId: '', coverFeatureId: '',
});
assert.equal(minimaxMusic.count, undefined, 'MiniMax must not receive Mureka count');
assert.equal(minimaxMusic.stream, undefined, 'MiniMax must not receive Mureka streaming');
assert.equal(minimaxMusic.referenceAssetId, undefined, 't2m must not receive cover references');

const soundtrack = buildSubmitMusicArgs({
  provider: 'mureka', mode: 'soundtrack', prompt: 'tense', sourceAssetId: 'image-1',
  styles: ['rock'], vocalId: 'voice-1', audioStartMs: 1000, audioEndMs: 6000,
  lyricsOptimizer: true, sampleRate: 44100,
});
assert.equal(soundtrack.sourceAssetId, 'image-1');
assert.equal(soundtrack.styles, undefined, 'soundtrack must not receive prompt-song controls');
assert.equal(soundtrack.vocalId, undefined, 'soundtrack must not receive song controls');
assert.equal(soundtrack.lyricsOptimizer, undefined, 'Mureka must not receive MiniMax controls');

const eleven = buildSubmitVoiceArgs({
  provider: 'elevenlabs', text: 'Hello', voiceId: 'peter', outputFormat: 'mp3_44100_128',
  volume: 1, sampleRate: 32000, audioFormat: 'mp3', speedRatio: 1,
});
assert.equal(eleven.volume, undefined, 'ElevenLabs must not receive MiniMax controls');
assert.equal(eleven.speedRatio, undefined, 'ElevenLabs must not receive Doubao controls');

const minimaxVoice = buildSubmitVoiceArgs({
  provider: 'minimax', text: '你好', voiceId: 'female-yujie', audioFormat: 'wav',
  bitrate: 128000, stream: false, excludeAggregatedAudio: false, forceCbr: false,
  subtitleEnable: false, subtitleType: 'sentence', stability: 0.5, speedRatio: 1,
  timbreWeights: [{ voiceId: 'male-qn-qingse', weight: 1 }],
});
assert.equal(minimaxVoice.bitrate, undefined, 'non-MP3 MiniMax output must not receive bitrate');
assert.equal(minimaxVoice.excludeAggregatedAudio, undefined, 'non-streaming output must not receive stream options');
assert.equal(minimaxVoice.subtitleType, undefined, 'disabled subtitles must not receive a subtitle type');
assert.equal(minimaxVoice.stability, undefined, 'MiniMax must not receive ElevenLabs controls');
assert.equal(minimaxVoice.speedRatio, undefined, 'MiniMax must not receive Doubao controls');
assert.equal(minimaxVoice.timbreWeights, undefined, 'an explicit voiceId wins over Agent-invented timbre mixing');

console.log('generation-tool-input.verify: ok');
