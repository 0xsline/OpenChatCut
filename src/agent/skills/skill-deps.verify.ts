// skill-deps: external-skill dependency detection + adaptation prompt.
// Sample text mirrors a real installed skill (paper-collage-ad style: Codex
// edition, image keyframes, voice cloning, ffmpeg pipeline) and verifies both
// the detection rules and the prompt output under configured/missing caps.
import { strict as assert } from 'node:assert';
import { detectSkillDependencies, skillDependencyPrompt } from './skill-deps';
import type { CapabilityKey } from '../capabilities';

const SAMPLE = `---
name: paper-collage-ad
description: Turn a brief into a paper-cut ad with image generation keyframes.
compatibility: OpenAI Codex desktop and CLI
---
# Paper Collage Ad
Run every command from a shell available to Codex. Install at ~/.codex/skills/.
Generate a locked set of finished keyframes with the image model.
Add narration with IndexTTS-2 voice cloning, music and sfx.
Validate the MP4 with ffmpeg and ffprobe.
The Gemini Omni motion pass animates the layers.
Scripts need npm install; run them through the run_code sandbox.`;

const capsAllOn = (): Record<CapabilityKey, boolean> => ({
  image: true, voice: true, video: true, music: true, sound: true,
  stock: true, transcription: true, sandbox: true, web: true,
});
const capsAllOff = (): Record<CapabilityKey, boolean> => ({
  image: false, voice: false, video: false, music: false, sound: false,
  stock: false, transcription: false, sandbox: false, web: false,
});

// --- detection -----------------------------------------------------------

const deps = detectSkillDependencies(SAMPLE);
const kinds = deps.map((d) => d.kind);
for (const expected of ['runtime', 'image', 'video', 'voice', 'sound', 'ffmpeg'] as const) {
  assert.ok(kinds.includes(expected), `expected dependency kind ${expected}, got ${kinds.join(',')}`);
}
// sandbox hints (shell commands, npm install) should also surface
assert.ok(kinds.includes('sandbox'), `expected sandbox kind, got ${kinds.join(',')}`);
const codex = deps.find((d) => d.kind === 'runtime');
assert.ok(codex && codex.keyword.includes('codex'), 'runtime keyword should mention codex');

// no false positives on an empty/neutral text
assert.deepEqual(detectSkillDependencies('plain text without services'), []);

// --- prompt: built-in skill never gets an adaptation block ------------------

const builtin = {
  id: 'b1', slug: 'long-video-to-shorts', name: 'x', nameZh: 'x', description: 'x',
  summary: 'x', scenarios: [], body: SAMPLE, files: [], source: 'builtin' as const,
};
assert.equal(skillDependencyPrompt(builtin, `${builtin.description}\n${builtin.body}`), '');

// --- prompt: everything configured → substitution wording --------------------

const custom = {
  id: 'c1', slug: 'paper-collage-ad', name: 'x', nameZh: 'x', description: 'x',
  summary: 'x', scenarios: [], body: SAMPLE, files: [], source: 'custom' as const,
};
const onPrompt = skillDependencyPrompt(custom, `${custom.description}\n${custom.body}`, capsAllOn());
assert.ok(onPrompt.includes('<selected_skill_adaptation>'), 'adaptation block must be present');
assert.ok(onPrompt.includes('use the local tool instead'), 'configured image must say local substitute');
assert.ok(onPrompt.includes('available here'), 'ffmpeg must be available');
assert.ok(!onPrompt.includes('NOT configured'), 'no missing services when caps on');
assert.ok(onPrompt.includes('substituted with this app'), 'on-path tells the user about substitution');

// --- prompt: nothing configured → missing wording + settings guidance ---------

const offPrompt = skillDependencyPrompt(custom, `${custom.description}\n${custom.body}`, capsAllOff());
assert.ok(offPrompt.includes('NOT configured'), 'off caps must flag missing services');
assert.ok(offPrompt.includes('do not call'), 'must forbid calling unconfigured tools');
assert.ok(offPrompt.includes('ask them to configure'), 'must guide the user to configure');
assert.ok(!offPrompt.includes('use the local tool instead'), 'no substitution when off');

// --- prompt: no detectable deps → no block ------------------------------------

const neutral = { ...custom, slug: 'plain', body: 'just text' };
assert.equal(skillDependencyPrompt(neutral, 'just text', capsAllOn()), '');

console.log('skill-deps.verify: detection + adaptation prompt OK');
