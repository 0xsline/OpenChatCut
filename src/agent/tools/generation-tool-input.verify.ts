import assert from 'node:assert/strict';
import { buildSubmitImageArgs, buildSubmitMusicArgs, buildSubmitSoundArgs, buildSubmitVideoArgs, buildSubmitVoiceArgs, shouldAddImageToTimeline } from './generate-tool-input';

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

const waveSpeed = buildSubmitImageArgs({
  model: 'wavespeed', prompt: 'octopus vs crab chess', name: 'chess', imageSize: '2K',
  width: 1024, height: 1024, promptOptimizer: true, quality: 'high',
});
assert.equal(waveSpeed.imageSize, '2K');
assert.equal(waveSpeed.promptOptimizer, undefined, 'WaveSpeed must not receive MiniMax-only options');
assert.equal(waveSpeed.quality, undefined, 'WaveSpeed must not receive GPT-only options');

const byteplusImage = buildSubmitImageArgs({
  model: 'byteplus', prompt: 'neon city street', name: 'city', imageSize: '2K',
  width: 1024, height: 1024, promptOptimizer: true, quality: 'high',
});
assert.equal(byteplusImage.imageSize, '2K');
assert.equal(byteplusImage.promptOptimizer, undefined, 'BytePlus must not receive MiniMax-only options');
assert.equal(byteplusImage.quality, undefined, 'BytePlus must not receive GPT-only options');

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

const byteplusVideo = buildSubmitVideoArgs({
  model: 'byteplus', prompt: 'wide shot', durationSeconds: 5, ratio: '16:9',
  refImages: ['', '  '], promptOptimizer: false, fastPretreatment: false, mode: 'std',
});
assert.equal(byteplusVideo.model, 'byteplus');
assert.equal(byteplusVideo.refImages, undefined, 'blank reference defaults are removed');
assert.equal(byteplusVideo.promptOptimizer, undefined, 'BytePlus must not receive MiniMax controls');
assert.equal(byteplusVideo.mode, undefined, 'BytePlus must not receive Kling mode');

const minimaxMusic = buildSubmitMusicArgs({
  provider: 'minimax', mode: 't2m', prompt: 'ambient', isInstrumental: true,
  count: 2, stream: false, styles: ['ambient'], referenceAssetId: '', coverFeatureId: '',
});
assert.equal(minimaxMusic.count, undefined, 'MiniMax must not receive Mureka count');
assert.equal(minimaxMusic.stream, undefined, 'MiniMax must not receive Mureka streaming');
assert.equal(minimaxMusic.referenceAssetId, undefined, 't2m must not receive cover references');

const atlasMusic = buildSubmitMusicArgs({
  provider: 'atlas', mode: 'cover', prompt: 'ambient', lyrics: 'soft lights', isInstrumental: false,
  lyricsOptimizer: true, count: 3, stream: true, referenceAssetId: 'audio-1', sampleRate: 32_000,
});
assert.equal(atlasMusic.provider, 'atlas');
assert.equal(atlasMusic.mode, 't2m', 'Atlas exposes only its schema-backed t2m mode');
assert.equal(atlasMusic.sampleRate, 32_000);
assert.equal(atlasMusic.lyricsOptimizer, undefined, 'Atlas must not receive MiniMax lyrics optimizer');
assert.equal(atlasMusic.count, undefined, 'Atlas must not receive Mureka count');
assert.equal(atlasMusic.referenceAssetId, undefined, 'Atlas must not receive MiniMax cover references');

const soundtrack = buildSubmitMusicArgs({
  provider: 'mureka', mode: 'soundtrack', prompt: 'tense', sourceAssetId: 'image-1',
  styles: ['rock'], vocalId: 'voice-1', audioStartMs: 1000, audioEndMs: 6000,
  lyricsOptimizer: true, sampleRate: 44100,
});
assert.equal(soundtrack.sourceAssetId, 'image-1');
assert.equal(soundtrack.styles, undefined, 'soundtrack must not receive prompt-song controls');
assert.equal(soundtrack.vocalId, undefined, 'soundtrack must not receive song controls');
assert.equal(soundtrack.lyricsOptimizer, undefined, 'Mureka must not receive MiniMax controls');

const soniloMusic = buildSubmitMusicArgs({
  provider: 'sonilo', mode: 'soundtrack', prompt: 'warm indie folk', sourceAssetId: 'cut-1',
  lyrics: 'hello', styles: ['pop'], count: 2, stream: true, bitrate: 128000, audioFormat: 'mp3',
});
assert.equal(soniloMusic.provider, 'sonilo');
assert.equal(soniloMusic.mode, 'v2m', 'sonilo always submits v2m');
assert.equal(soniloMusic.sourceAssetId, 'cut-1');
assert.equal(soniloMusic.prompt, 'warm indie folk');
assert.equal(soniloMusic.lyrics, undefined, 'sonilo must not receive lyrics');
assert.equal(soniloMusic.styles, undefined, 'sonilo must not receive Mureka styles');
assert.equal(soniloMusic.count, undefined, 'sonilo must not receive Mureka count');
assert.equal(soniloMusic.stream, undefined, 'sonilo must not receive Mureka streaming');
assert.equal(soniloMusic.bitrate, undefined, 'sonilo must not receive MiniMax audio settings');
assert.equal(soniloMusic.audioFormat, undefined, 'sonilo output format is fixed');

const elevenSound = buildSubmitSoundArgs({
  prompt: 'thunder', durationSeconds: 4, promptInfluence: 0.5, loop: true, sourceAssetId: 'cut-1',
});
assert.equal(elevenSound.provider, 'elevenlabs', 'sound provider defaults to elevenlabs');
assert.equal(elevenSound.prompt, 'thunder');
assert.equal(elevenSound.sourceAssetId, undefined, 'ElevenLabs must not receive a sonilo video source');

const soniloSound = buildSubmitSoundArgs({
  provider: 'sonilo', sourceAssetId: 'cut-1', prompt: 'whoosh', durationSeconds: 4,
  promptInfluence: 0.5, loop: true, outputFormat: 'mp3_44100_128', name: 'cut sfx',
});
assert.equal(soniloSound.provider, 'sonilo');
assert.equal(soniloSound.sourceAssetId, 'cut-1');
assert.equal(soniloSound.name, 'cut sfx');
assert.equal(soniloSound.prompt, undefined, 'sonilo SFX are generated from the video, not a prompt');
assert.equal(soniloSound.durationSeconds, undefined, 'sonilo must not receive ElevenLabs duration');
assert.equal(soniloSound.loop, undefined, 'sonilo must not receive ElevenLabs loop');
assert.equal(soniloSound.outputFormat, undefined, 'sonilo must not receive ElevenLabs output format');

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

const inworldVoice = buildSubmitVoiceArgs({
  provider: 'inworld', text: 'Hello', voiceId: 'Dennis', modelId: 'inworld-tts-2', pitch: 1, speed: 1,
});
assert.equal(inworldVoice.modelId, 'inworld-tts-2');
assert.equal(inworldVoice.pitch, undefined, 'Inworld must not receive Doubao/MiniMax controls');
assert.equal(inworldVoice.speed, undefined, 'Inworld must not receive ElevenLabs/MiniMax controls');

const fishAudioVoice = buildSubmitVoiceArgs({
  provider: 'fishaudio', text: 'Hello', voiceId: 'ref-123', emotion: 'calm',
});
assert.equal(fishAudioVoice.provider, 'fishaudio');
assert.equal(fishAudioVoice.emotion, undefined, 'Fish Audio must not receive Doubao/MiniMax controls');

const speechifyVoice = buildSubmitVoiceArgs({
  provider: 'speechify', text: 'Hello', voiceId: 'george', modelId: 'simba-english', volume: 2,
});
assert.equal(speechifyVoice.modelId, 'simba-english');
assert.equal(speechifyVoice.volume, undefined, 'Speechify must not receive MiniMax controls');

const genericVoiceInput = {
  text: 'Configured provider voice',
  voiceId: 'confirmed-provider-voice-id',
  modelId: 'configured-model',
  speed: 1.1,
  languageCode: 'en',
  outputFormat: 'mp3',
  instructions: 'Warm and concise',
  stability: 0.5,
  pitch: 2,
};

const genericExpectations = [
  { provider: 'openai', speed: true, languageCode: false, instructions: true },
  { provider: 'gemini', speed: false, languageCode: false, instructions: true },
  { provider: 'mistral', speed: false, languageCode: false, instructions: false },
  { provider: 'cartesia', speed: true, languageCode: true, instructions: false },
] as const;

for (const expected of genericExpectations) {
  const voice = buildSubmitVoiceArgs({ ...genericVoiceInput, provider: expected.provider });
  assert.equal(voice.provider, expected.provider, `${expected.provider} must not fall back to ElevenLabs`);
  assert.equal(voice.voiceId, genericVoiceInput.voiceId);
  assert.equal(voice.modelId, genericVoiceInput.modelId);
  assert.equal(voice.outputFormat, genericVoiceInput.outputFormat);
  assert.equal(voice.speed, expected.speed ? genericVoiceInput.speed : undefined);
  assert.equal(voice.languageCode, expected.languageCode ? genericVoiceInput.languageCode : undefined);
  assert.equal(voice.instructions, expected.instructions ? genericVoiceInput.instructions : undefined);
  assert.equal(voice.stability, undefined, `${expected.provider} must not receive ElevenLabs controls`);
  assert.equal(voice.pitch, undefined, `${expected.provider} must not receive Doubao/MiniMax controls`);
}

console.log('generation-tool-input.verify: ok');
