import assert from 'node:assert';
import { timelineToFcpxml } from './fcpxml';
import type { TimelineState } from '../editor/types';

// 2 个 motion-graphic + 1 条音频，fps 30，覆盖 V1/A1 两条轨。
// mg-1 的名字故意带 & 和 <> 用来测转义。
const state: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  items: [
    { id: 'mg-1', track: 'V1', startFrame: 0, durationInFrames: 60, name: 'Title & <Intro>', kind: 'motion-graphic' },
    { id: 'mg-2', track: 'V1', startFrame: 60, durationInFrames: 90, name: 'Outro Card', kind: 'motion-graphic' },
    { id: 'vo-1', track: 'A1', startFrame: 0, durationInFrames: 150, name: 'Voiceover', kind: 'audio', src: '/media/uploads/vo.mp3' },
  ],
};

const xml = timelineToFcpxml(state, { title: 'Check Project' });

// 1. 单根 <fcpxml>，结构完整
assert.ok(xml.trim().startsWith('<?xml'), 'should start with an XML declaration');
assert.ok(xml.trim().endsWith('</fcpxml>'), 'should end with the closing fcpxml tag');
assert.strictEqual((xml.match(/<fcpxml /g) ?? []).length, 1, 'exactly one fcpxml root element');
for (const tag of ['<resources>', '<library>', '<sequence', '<spine>']) {
  assert.ok(xml.includes(tag), `missing ${tag}`);
}

// 2. format 的 frameDuration / width / height 正确
assert.ok(xml.includes('frameDuration="1/30s"'), 'frameDuration should be 1/30s at fps 30');
assert.ok(xml.includes('width="1920"'), 'format width should be 1920');
assert.ok(xml.includes('height="1080"'), 'format height should be 1080');

// 3. 精确抽查 mg-2 的 offset/duration 有理数时间：60/90 帧 @ 30fps
const mg2 = xml.match(/<gap name="MG: Outro Card"[^>]*>/);
assert.ok(mg2, 'mg-2 gap element should exist');
assert.ok(mg2![0].includes('offset="60/30s"'), `mg-2 offset should be 60/30s, got: ${mg2![0]}`);
assert.ok(mg2![0].includes('duration="90/30s"'), `mg-2 duration should be 90/30s, got: ${mg2![0]}`);

// 4. spine 上的片段数（asset-clip + MG 占位 gap）等于输入 item 数
const assetClipCount = (xml.match(/<asset-clip /g) ?? []).length;
const mgGapCount = (xml.match(/<gap name="MG: /g) ?? []).length;
assert.strictEqual(assetClipCount + mgGapCount, state.items.length, 'spine clip count should match item count');

// 5. 名字里的 & / < / > 被正确转义，原文不应残留
assert.ok(xml.includes('Title &amp; &lt;Intro&gt;'), 'name should be XML-escaped');
assert.ok(!xml.includes('Title & <Intro>'), 'raw unescaped name must not leak into the XML');

// 6. 输出不含 undefined/NaN
assert.ok(!/undefined/.test(xml), 'output must not contain "undefined"');
assert.ok(!/NaN/.test(xml), 'output must not contain "NaN"');

// 7. 全文 golden — 锁定整份 FCPXML 字节输出与关键属性词汇：
//    frameDuration / hasVideo / hasAudio / colorSpace / fcp_xml_resolve。
//    bundle 确认一致;此 golden 防我方序列化器格式回归(任何漂移都在此炸并显示 diff)。
const GOLDEN_DEFAULT = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="fmt1" name="FFVideoFormatCustom1920x1080p30" frameDuration="1/30s" width="1920" height="1080"/>
    <asset id="id-vo-1" name="vo.mp3" src="file:///media/uploads/vo.mp3" start="0s" duration="150/30s" hasVideo="0" hasAudio="1"/>
  </resources>
  <library>
    <event name="OpenChatCut Export">
      <project name="Check Project">
        <sequence format="fmt1" duration="150/30s" tcStart="0/30s" tcFormat="NDF">
          <spine>
            <gap name="Background" offset="0/30s" duration="150/30s">
        <gap name="MG: Title &amp; &lt;Intro&gt;" lane="1" offset="0/30s" duration="60/30s"><!-- motion graphic placeholder, render before NLE import: Title &amp; &lt;Intro&gt; --></gap>
        <gap name="MG: Outro Card" lane="1" offset="60/30s" duration="90/30s"><!-- motion graphic placeholder, render before NLE import: Outro Card --></gap>
        <asset-clip ref="id-vo-1" lane="-1" offset="0/30s" duration="150/30s" start="0/30s" name="Voiceover"/>
      </gap>
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`;
assert.strictEqual(xml.trim(), GOLDEN_DEFAULT.trim(), 'FCPXML output drifted from the golden (fcp_xml / Premiere)');

// 8. Resolve 变体 (fcp_xml_resolve) 只应在 format colorSpace + event name 两处不同
const resolveXml = timelineToFcpxml(state, { title: 'Check Project', nleFormat: 'fcp_xml_resolve' });
assert.ok(resolveXml.includes('colorSpace="1-1-1 (Rec. 709)"'), 'resolve format carries Rec.709 colorSpace');
assert.ok(resolveXml.includes('<event name="OpenChatCut Export (Resolve)">'), 'resolve event is named for Resolve');
assert.ok(!xml.includes('colorSpace'), 'default (Premiere) format omits colorSpace');
const dLines = xml.split('\n');
const diff = resolveXml.split('\n').filter((ln, i) => ln !== dLines[i]);
assert.strictEqual(diff.length, 2, `resolve should differ from default in exactly 2 lines (format+event), got ${diff.length}`);

console.log('fcpxml.check: ok (+ golden 全文锁定 + resolve 变体)');
