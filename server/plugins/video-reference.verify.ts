import assert from 'node:assert/strict';
import type { VideoRequest } from './video-validation';
import { materializeVideoReferences, ServerReferencePreflightError } from './video-media';

const request = (model: VideoRequest['model'], references: unknown[]): VideoRequest => ({
  model,
  prompt: 'Reference preflight',
  generationReferences: references,
});

await assert.rejects(
  materializeVideoReferences(request('kling', [{
    kind: 'asset-master',
    role: 'reference-audio',
    assetId: 'audio-1',
    path: '/media/uploads/reference.wav',
  }])),
  (error: unknown) => error instanceof ServerReferencePreflightError
    && error.code === 'generation_reference_preflight'
    && error.issues.some((issue) => issue.code === 'kling_audio_unsupported'),
  'the server must independently reject unsupported provider roles before provider submission',
);

await assert.rejects(
  materializeVideoReferences(request('seedance2', [{
    kind: 'asset-master',
    role: 'last-frame',
    assetId: 'image-last',
    path: '/media/uploads/last.png',
  }])),
  (error: unknown) => error instanceof ServerReferencePreflightError
    && error.issues.some((issue) => issue.code === 'last_frame_requires_first'),
  'server preflight must not rely on a client-only last-frame invariant',
);

await assert.rejects(
  materializeVideoReferences(request('hailuo', [{
    kind: 'asset-master',
    role: 'reference-video',
    assetId: 'video-1',
    path: '/media/uploads/reference.mp4',
  }])),
  (error: unknown) => error instanceof ServerReferencePreflightError
    && error.issues.some((issue) => issue.code === 'hailuo_reference_role'),
);

console.log('server generation reference preflight checks passed');
