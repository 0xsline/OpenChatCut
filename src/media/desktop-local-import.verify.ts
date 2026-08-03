import assert from 'node:assert/strict';
import {
  shouldNormalizeImportedVideo,
  transferDesktopLocalMedia,
  type DesktopLocalMediaApi,
} from './upload';

assert.equal(
  shouldNormalizeImportedVideo('video', { src: '/media/uploads/prores.mov', storedName: 'prores.mov' }),
  true,
  'ordinary desktop ProRes/HEVC imports still enter canonical compatibility normalization',
);
assert.equal(
  shouldNormalizeImportedVideo('video', {
    src: '/media/uploads/alpha.webm',
    storedName: 'alpha.mov',
    proxyKind: 'alpha-webm',
  }),
  false,
  'an explicitly identified alpha WebM proxy bypasses destructive compatibility normalization',
);
assert.equal(shouldNormalizeImportedVideo('video', null), true, 'browser video uploads use the same canonical normalizer');
assert.equal(
  shouldNormalizeImportedVideo('audio', { src: '/media/uploads/voice.wav', storedName: 'voice.wav' }),
  false,
  'non-video media never enters video normalization',
);

const videoFile = { name: 'camera-original.mp4' } as File;
const nativeImport = {
  src: '/media/uploads/native-camera.mp4',
  storedName: 'native-camera.mp4',
};
let nativeBridgeCalls = 0;
let httpUploadCalls = 0;
const nativeTransfer = await transferDesktopLocalMedia(
  videoFile,
  {
    importLocalMedia: async (file) => {
      nativeBridgeCalls += 1;
      assert.equal(file, videoFile);
      return nativeImport;
    },
  },
  async () => {
    httpUploadCalls += 1;
    return '/upload/should-not-run.mp4';
  },
);
assert.deepEqual(nativeTransfer, {
  src: nativeImport.src,
  desktopImport: nativeImport,
});
assert.equal(nativeBridgeCalls, 1, 'renderer must invoke the available desktop bridge');
assert.equal(httpUploadCalls, 0, 'a successful desktop bridge must bypass the HTTP uploader');

const missingBridgeTransfer = await transferDesktopLocalMedia(
  videoFile,
  undefined,
  async (file) => {
    httpUploadCalls += 1;
    assert.equal(file, videoFile);
    return '/media/uploads/browser-fallback.mp4';
  },
);
assert.deepEqual(missingBridgeTransfer, {
  src: '/media/uploads/browser-fallback.mp4',
  desktopImport: null,
});
assert.equal(httpUploadCalls, 1, 'a browser without the desktop bridge must use HTTP upload');

const pathlessApi: DesktopLocalMediaApi = {
  importLocalMedia: async () => null,
};
const pathlessTransfer = await transferDesktopLocalMedia(
  videoFile,
  pathlessApi,
  async () => {
    httpUploadCalls += 1;
    return '/media/uploads/pathless-fallback.mp4';
  },
);
assert.deepEqual(pathlessTransfer, {
  src: '/media/uploads/pathless-fallback.mp4',
  desktopImport: null,
});
assert.equal(httpUploadCalls, 2, 'a File without a native path must use HTTP upload');

await assert.rejects(
  transferDesktopLocalMedia(
    videoFile,
    { importLocalMedia: async () => { throw new Error('native bridge failed'); } },
    async () => {
      httpUploadCalls += 1;
      return '/media/uploads/error-fallback.mp4';
    },
  ),
  /native bridge failed/,
  'native filesystem failures must surface instead of silently streaming the File over HTTP',
);
assert.equal(httpUploadCalls, 2, 'HTTP fallback is only for an absent bridge or a pathless File');

const movFile = { name: 'transparent-title.mov' } as File;
let proxyStoredName = '';
const alphaTransfer = await transferDesktopLocalMedia(
  movFile,
  {
    importLocalMedia: async () => ({
      src: '/media/uploads/transparent-title.mov',
      storedName: 'transparent-title.mov',
    }),
    prepareTransparentMovProxy: async (storedName) => {
      proxyStoredName = storedName;
      return { src: '/media/uploads/transparent-title.alpha.webm' };
    },
  },
  async () => {
    throw new Error('HTTP upload must not run after native MOV import');
  },
);
assert.equal(proxyStoredName, 'transparent-title.mov');
assert.deepEqual(alphaTransfer, {
  src: '/media/uploads/transparent-title.alpha.webm',
  desktopImport: {
    src: '/media/uploads/transparent-title.alpha.webm',
    storedName: 'transparent-title.mov',
    proxyKind: 'alpha-webm',
  },
}, 'a successful transparent MOV proxy must be identified behaviorally');

console.log('desktop-local-import.verify: native bridge transfer and HTTP fallback behavior passed');
