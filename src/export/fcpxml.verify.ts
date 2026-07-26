// Runnable check: `npx tsx src/export/fcpxml.verify.ts`.
// 验证 FCPXML 导出:结构与转义、轨道→lane、MG 占位/烘焙引用,以及两条 P0 修复——
// ① 音频文字稿编辑必须拆成与播放层(keptSegments)逐段一致的多条 asset-clip;
// ② 素材换算成 mediaDir 下的绝对 file:// 路径,否则 NLE 里全是离线素材。
import assert from 'node:assert/strict';
import { resolveAssetSrc, timelineToFcpxml } from './fcpxml';
import { keptSegments } from '../transcript/edit';
import type { TimelineState } from '../editor/types';

const clipsOf = (xml: string): string[] => xml.match(/<asset-clip[^>]*\/>/g) ?? [];
const attr = (el: string, name: string): string => el.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? '';

// ── 基础结构:单根、必需节点、XML 转义、无 undefined/NaN 泄漏 ──
{
  const state: TimelineState = {
    fps: 30, width: 1920, height: 1080, selectedId: null,
    items: [
      { id: 'mg-1', track: 'V1', startFrame: 0, durationInFrames: 60, name: 'Title & <Intro>', kind: 'motion-graphic' },
      { id: 'mg-2', track: 'V1', startFrame: 60, durationInFrames: 90, name: 'Outro Card', kind: 'motion-graphic' },
      { id: 'vo-1', track: 'A1', startFrame: 0, durationInFrames: 150, name: 'Voiceover', kind: 'audio', src: '/media/uploads/vo.mp3' },
    ],
  };
  const xml = timelineToFcpxml(state, { title: 'Check Project' });
  assert.ok(xml.trim().startsWith('<?xml'), 'XML 声明开头');
  assert.ok(xml.trim().endsWith('</fcpxml>'), 'fcpxml 收尾');
  assert.equal((xml.match(/<fcpxml /g) ?? []).length, 1, '单根元素');
  for (const tag of ['<resources>', '<library>', '<sequence', '<spine>']) {
    assert.ok(xml.includes(tag), `缺少 ${tag}`);
  }
  assert.ok(xml.includes('frameDuration="1/30s"'), 'fps 30 → frameDuration 1/30s');
  assert.ok(xml.includes('Title &amp; &lt;Intro&gt;'), '名字要转义');
  assert.ok(!xml.includes('Title & <Intro>'), '未转义原文不得泄漏');
  assert.ok(!/undefined|NaN/.test(xml), '输出不得含 undefined/NaN');
  // MG 无媒体 → 占位 gap;音频 → asset-clip
  assert.equal(clipsOf(xml).length, 1, '仅音频出 asset-clip');
  assert.equal((xml.match(/<gap name="MG:/g) ?? []).length, 2, '两个 MG 占位 gap');
  // 轨道 → lane:视频正、音频负
  assert.equal(attr(clipsOf(xml)[0]!, 'lane'), '-1', '音频挂负 lane');
}

// ── P0-①:音频文字稿编辑 → 多段,逐段与 keptSegments 对齐 ──
{
  // hello 0–1s | ummmm 1–3s(删) | world 3–4s,时间戳是毫秒
  const transcript = [
    { text: 'hello', start: 0, end: 1000 },
    { text: 'ummmm', start: 1000, end: 3000 },
    { text: 'world', start: 3000, end: 4000 },
  ];
  const segs = keptSegments(transcript, new Set([1]), 30, 0, {});
  const edited = segs.reduce((sum, seg) => sum + seg.durFrames, 0);
  const state: TimelineState = {
    fps: 30, width: 1920, height: 1080, selectedId: null,
    tracks: { A1: { kind: 'audio' } }, trackOrder: ['A1'],
    items: [{
      id: 'vo', track: 'A1', startFrame: 0, durationInFrames: edited, kind: 'audio',
      name: '配音', src: '/media/uploads/vo.wav', transcript, deletedWordIdx: [1],
    }],
  };
  const clips = clipsOf(timelineToFcpxml(state));
  assert.equal(clips.length, segs.length, `导出段数须等于播放段数(${segs.length})`);
  segs.forEach((seg, i) => {
    assert.equal(attr(clips[i]!, 'offset'), `${seg.fromFrame}/30s`, `第 ${i + 1} 段时间线位置`);
    assert.equal(attr(clips[i]!, 'duration'), `${seg.durFrames}/30s`, `第 ${i + 1} 段时长`);
    assert.equal(attr(clips[i]!, 'start'), `${seg.srcStartFrame}/30s`, `第 ${i + 1} 段源入点`);
  });
  // 回归红线:删掉的词绝不能被某一段覆盖(源 30–90 帧)
  const covers = clips.some((c) => {
    const s = Number(attr(c, 'start').split('/')[0]);
    const d = Number(attr(c, 'duration').split('/')[0]);
    return s < 90 && s + d > 30;
  });
  assert.ok(!covers, '删掉的口癖不得出现在任何一段里');
  // asset 时长要盖住实际用到的最远源帧(编辑后时长 60 < 用到的 120)
  const assetDur = timelineToFcpxml(state).match(/<asset [^>]*duration="([^"]*)"/)?.[1];
  assert.equal(assetDur, '120/30s', 'asset 时长按真实用到的源区间');
}

// ── video 件的删词不改画面 → 仍是单段(与渲染层语义一致) ──
{
  const state: TimelineState = {
    fps: 30, width: 1920, height: 1080, selectedId: null,
    tracks: { V1: { kind: 'video' } }, trackOrder: ['V1'],
    items: [{
      id: 'cam', track: 'V1', startFrame: 0, durationInFrames: 60, kind: 'video',
      name: '机位', src: '/media/uploads/cam.mp4',
      transcript: [{ text: 'a', start: 0, end: 1000 }, { text: 'b', start: 1000, end: 2000 }],
      deletedWordIdx: [0],
    }],
  };
  assert.equal(clipsOf(timelineToFcpxml(state)).length, 1, 'video 件保持单段连续播放');
}

// ── P0-②:素材路径换算成绝对 file:// ──
{
  assert.equal(
    resolveAssetSrc('/media/uploads/a.mp4', '/Users/me/proj/public/media/uploads'),
    'file:///Users/me/proj/public/media/uploads/a.mp4',
    'POSIX 绝对路径',
  );
  assert.equal(
    resolveAssetSrc('/media/uploads/%E9%87%87%E8%AE%BF.mp4', '/Users/me/媒体'),
    'file:///Users/me/%E5%AA%92%E4%BD%93/%E9%87%87%E8%AE%BF.mp4',
    '中文目录与文件名逐段编码',
  );
  assert.equal(
    resolveAssetSrc('/media/uploads/b roll.mov', '/Users/me/clips/'),
    'file:///Users/me/clips/b%20roll.mov',
    '空格编码 + 目录尾斜杠归一',
  );
  assert.equal(
    resolveAssetSrc('/media/uploads/a.mp4', 'D:\\Media\\Uploads'),
    'file:///D:/Media/Uploads/a.mp4',
    'Windows 盘符路径(冒号保持原样)',
  );
  assert.equal(
    resolveAssetSrc('https://cdn.example.com/a.mp4', '/Users/me/clips'),
    'https://cdn.example.com/a.mp4',
    '远程地址原样透传,不谎报本地路径',
  );
  assert.equal(
    resolveAssetSrc('/media/uploads/a.mp4'),
    'file:///media/uploads/a.mp4',
    '无 mediaDir 时退回原路径(导出仍可出,素材离线)',
  );

  const state: TimelineState = {
    fps: 30, width: 1920, height: 1080, selectedId: null,
    tracks: { A1: { kind: 'audio' } }, trackOrder: ['A1'],
    items: [{ id: 'a', track: 'A1', startFrame: 0, durationInFrames: 30, kind: 'audio', name: '音', src: '/media/uploads/采访.wav' }],
  };
  const xml = timelineToFcpxml(state, { mediaDir: '/Users/me/clips' });
  assert.ok(xml.includes('src="file:///Users/me/clips/'), '导出串到 asset 的 src 上');
  assert.ok(xml.includes('name="采访.wav"'), 'asset 名字用可读的解码后文件名');
}

// ── Resolve 变体保留既有差异 ──
{
  const state: TimelineState = {
    fps: 30, width: 1920, height: 1080, selectedId: null,
    items: [{ id: 'a', track: 'A1', startFrame: 0, durationInFrames: 30, kind: 'audio', name: 'a', src: '/media/uploads/a.mp3' }],
  };
  const resolveXml = timelineToFcpxml(state, { nleFormat: 'fcp_xml_resolve' });
  assert.ok(resolveXml.includes('colorSpace="1-1-1 (Rec. 709)"'), 'Resolve 变体带 Rec.709');
  assert.ok(resolveXml.includes('<event name="OpenChatCut Export (Resolve)">'), 'Resolve 事件名');
  assert.ok(!timelineToFcpxml(state).includes('colorSpace'), '默认变体不带 colorSpace');
}

console.log('fcpxml.verify: ok (结构/转义/lane/分段与播放一致/绝对路径/Resolve 变体)');
