import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shouldNormalizeImportedVideo } from './upload';

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

const source = readFileSync(new URL('./upload.ts', import.meta.url), 'utf8');
assert.match(source, /openChatCutDesktop\?: DesktopLocalMediaApi/, '桌面导入桥必须保持可选，网页端继续使用上传回退');
assert.match(source, /await api\.importLocalMedia\(file\)/, '桌面文件必须先走本机导入桥');
assert.match(source, /proxyKind: 'alpha-webm'/, '只有透明 MOV 代理成功时才标记 alpha WebM');
assert.match(source, /desktopImport\?\.src \?\? await uploadFile/, '没有桌面桥时必须回退现有上传流程');
assert.match(
  source,
  /shouldNormalizeImportedVideo\(kind, desktopImport\)[\s\S]*normalizeUploadedVideo\(srcRaw\)/,
  '所有非 alpha WebM 视频必须调用 canonical normalizeUploadedVideo(srcRaw)',
);
assert.match(source, /src === srcRaw && !desktopImport/, '本机直入素材不得重复写入浏览器 Blob 缓存');

console.log('desktop-local-import.verify: explicit alpha proxy and canonical normalize routing are wired');
