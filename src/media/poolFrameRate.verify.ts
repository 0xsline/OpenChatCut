// Issue #184: a 6 s clip read 0:08 in the media pool. The project switched to
// 24 fps while the upload was still transcoding: the placeholder was recounted
// to 144 frames, then the finished import wrote back the 180 it had counted at
// 30 fps. Media that lands after the rate changed — a finished upload, a
// relinked file, a phone or watch-folder import, an agent's generated media,
// template media — says which rate its duration was counted at, and the pool
// keeps it at the project rate.
// Run: npx tsx src/media/poolFrameRate.verify.ts
import assert from 'node:assert/strict';
import { copyTemplateAssets } from '../agent/tools/template-tools';
import { makeDraft, replayActions } from '../editor/store';
import { activeTimeline, type MediaAsset, type ProjectDoc } from '../editor/types';
import { docFromTimeline } from '../persist/projectStore';
import { directoryFileToAsset } from './directoryImportAsset';
import { mediaAssetRelinkPatch } from './mediaAssetRelink';
import { durationLabel } from './mediaPoolFormat';
import { poolImportHooks } from './poolImportRun';
import { createImportTranscriptionGate } from './upload';

const project = (fps = 30): ProjectDoc => docFromTimeline({
  fps, width: 1920, height: 1080, selectedId: null, trackOrder: ['V1'], tracks: { V1: { kind: 'video' } }, items: [],
});
const pooled = (doc: ProjectDoc, id: string) => doc.assets.find((asset) => asset.id === id)!;
/** The media card's duration: pool frames read at the active sequence's rate (MediaPoolCard). */
const card = (doc: ProjectDoc, id: string) => durationLabel(pooled(doc, id).durationInFrames, activeTimeline(doc).fps);
const clip = (id: string, durationInFrames: number, src = `/media/uploads/${id}.mp4`): MediaAsset => ({
  id, name: `${id}.mp4`, kind: 'video', src, durationInFrames,
});

// ── The reported race: 24 fps is picked while the upload is still transcoding ──
{
  const editor = makeDraft(project());
  const importFps = editor.getState().fps; // importMedia(file, stateRef.current.fps, hooks)
  editor.commands.addAsset(clip('upload', 6 * importFps, 'blob:upload'), importFps); // onPlaceholder
  editor.commands.setProjectFps(24);
  assert.equal(pooled(editor.getDoc(), 'upload').durationInFrames, 144, 'the placeholder is recounted');
  editor.commands.relinkMediaAsset('upload', mediaAssetRelinkPatch(clip('upload', 6 * importFps), importFps)); // onReady
  assert.equal(card(editor.getDoc(), 'upload'), '0:06', 'the finished import keeps the clip at 6 s');
  assert.equal(pooled(editor.getDoc(), 'upload').durationInFrames, 144);
  assert.equal(pooled(editor.getDoc(), 'upload').src, '/media/uploads/upload.mp4');
}

// ── The same race through the hooks the editor's pool import uses ──
{
  const editor = makeDraft(project());
  const hooks = poolImportHooks({
    commands: editor.commands,
    stateRef: { get current() { return editor.getState(); } },
    startAssetTranscription: () => undefined,
    placeholderId: null,
    placeholder: null,
    canonicalizedAsset: null,
    transcriptionGate: createImportTranscriptionGate(),
  });
  const voice: MediaAsset = { id: 'voice', name: 'voice.wav', kind: 'audio', src: 'blob:voice', durationInFrames: 180 };
  hooks.onPlaceholder!(voice, 30);
  editor.commands.setProjectFps(24);
  hooks.onReady!({ ...voice, src: '/media/uploads/voice.wav' }, 30);
  assert.equal(card(editor.getDoc(), 'voice'), '0:06');
  assert.equal(pooled(editor.getDoc(), 'voice').src, '/media/uploads/voice.wav');
}

// ── Relink File on an unused clip, finishing after the switch to 60 fps ──
{
  const editor = makeDraft({ ...project(), assets: [clip('offline', 180, '/media/uploads/missing.mp4')] });
  const relinkFps = editor.getState().fps;
  editor.commands.setProjectFps(60);
  editor.commands.relinkMediaAsset('offline', mediaAssetRelinkPatch(clip('offline', 8 * relinkFps), relinkFps));
  assert.equal(pooled(editor.getDoc(), 'offline').durationInFrames, 480, 'the 8 s replacement at 60 fps');
  assert.equal(card(editor.getDoc(), 'offline'), '0:08');
}

// ── Phone and watch-folder imports probe first and land later ──
{
  const editor = makeDraft(project());
  const probeFps = editor.getState().fps;
  const watched = await directoryFileToAsset({
    importId: 'watch-1', name: 'watched.mp4', src: '/media/uploads/watched.mp4', storedName: 'watched.mp4',
    contentHash: 'a'.repeat(64), kind: 'video', size: 1, durationSeconds: 6, sourceModifiedAt: 1,
    compatibilityNormalized: true,
  }, probeFps, { createId: () => 'watched' });
  editor.commands.setProjectFps(24);
  editor.commands.addAsset(watched, probeFps); // ingestToPool(asset, fps)
  assert.equal(card(editor.getDoc(), 'watched'), '0:06');
  assert.equal(pooled(editor.getDoc(), 'watched').sourceRevision, watched.sourceRevision, 'identity is the probed file\'s');
}

// ── An agent's generated media lands on the live project after the switch ──
{
  const base = project();
  const agent = makeDraft(base);
  agent.commands.addAsset(clip('generated', 6 * agent.getState().fps)); // generate-tool-handlers addAsset
  const recorded = agent.takeActions();
  const live = makeDraft(base);
  live.commands.setProjectFps(24);
  const landed = replayActions(live.getDoc(), recorded); // useAgentRun landOperations
  assert.equal(card(landed, 'generated'), '0:06', 'counted at the draft rate, landed at the live one');
  assert.equal(pooled(landed, 'generated').durationInFrames, 144);
  assert.equal(pooled(agent.getDoc(), 'generated').durationInFrames, 180, 'the draft itself is unchanged');
}

// ── Template media counted at the template's rate joins a 24 fps project ──
{
  const template = { ...project(30), assets: [clip('bumper', 180)] };
  const copied = copyTemplateAssets(project(24), {
    id: 'tpl', name: 'Bumper', createdAt: 0, doc: template, assetIds: ['bumper'],
  });
  const [bumper] = copied.assets;
  assert.equal(card(copied.doc, bumper!.assetId), '0:06');
}

// ── Media counted at the current rate lands unchanged ──
{
  const editor = makeDraft(project());
  editor.commands.addAsset(clip('same', 180));
  editor.commands.addAsset({ ...clip('graphic', 90), kind: 'motion-graphic', code: 'x' }, 60);
  assert.equal(pooled(editor.getDoc(), 'same').durationInFrames, 180);
  assert.equal(pooled(editor.getDoc(), 'graphic').durationInFrames, 90, 'authored frames stay as authored');
}

console.log('poolFrameRate.verify: media that lands after a rate change keeps its seconds');
