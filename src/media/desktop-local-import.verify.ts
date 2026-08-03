import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./upload.ts', import.meta.url), 'utf8');

assert.match(source, /openChatCutDesktop\?: DesktopLocalMediaApi/, '桌面导入桥必须保持可选，网页端继续使用上传回退');
assert.match(source, /await api\.importLocalMedia\(file\)/, '桌面文件必须先走本机导入桥');
assert.match(source, /\/\\\.mov\$\/i[\s\S]*prepareTransparentMovProxy/, 'MOV 必须请求透明通道代理');
assert.match(source, /desktopImport\?\.src \?\? await uploadFile/, '没有桌面桥时必须回退现有上传流程');
assert.match(source, /kind === 'video' && !desktopImport/, '本机直入素材不得再次执行破坏透明通道的兼容性转码');
assert.match(source, /src === srcRaw && !desktopImport/, '本机直入素材不得重复写入浏览器 Blob 缓存');

console.log('desktop-local-import.verify: desktop fast path and transparent MOV proxy are wired');
