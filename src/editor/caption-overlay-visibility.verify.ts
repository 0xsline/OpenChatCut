// 字幕覆盖层可见性检查:npx tsx src/editor/caption-overlay-visibility.verify.ts
// 工具栏(CC 按钮)与渲染层必须用同一条规则判断 captionsHidden 未设置时的默认值。
// 曾经各判各的:渲染层只认「有启用的字幕轨」,工具栏还认「存在文字/MG 片段」。
// 于是关掉字幕轨之后,带文字或颜色属性的 MG 在画面里被静默隐藏,而 CC 按钮仍显示
// 「开」——用户只看到 MG 消失,没有任何线索指向字幕。
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { captionOverlayVisible } from './timelineTypes';
import type { TimelineState } from './timelineTypes';

const base = (over: Partial<TimelineState> = {}): TimelineState => ({
  id: 'tl', name: 't', fps: 30, width: 1920, height: 1080, items: [], tracks: {}, ...over,
} as TimelineState);

const mg = { id: 'i1', track: 'V2', kind: 'motion-graphic', startFrame: 0, durationInFrames: 30, name: 'badge' } as TimelineState['items'][number];
const captionTrack = (enabled: boolean) => ({
  C1: {
    kind: 'caption',
    captions: { enabled, template: 'bubble-pop', pacing: 'phrase', sources: [], sourceMode: 'item', bilingual: false },
  },
} as unknown as TimelineState['tracks']);

// ── 显式开关永远优先 ────────────────────────────────────────────────────────
assert.equal(captionOverlayVisible(base({ captionsHidden: true, items: [mg] })), false, '显式隐藏');
assert.equal(captionOverlayVisible(base({ captionsHidden: false, tracks: captionTrack(false) })), true, '显式显示');

// ── 回归红线:字幕轨关闭 + 存在 MG → 仍然可见 ───────────────────────────────
assert.equal(
  captionOverlayVisible(base({ tracks: captionTrack(false), items: [mg] })),
  true,
  '关掉字幕轨不能连带隐藏 MG(本文件顶部描述的线上故障)',
);

// ── 其余默认分支 ───────────────────────────────────────────────────────────
assert.equal(captionOverlayVisible(base({ tracks: captionTrack(true) })), true, '有启用的字幕轨');
assert.equal(captionOverlayVisible(base({ tracks: captionTrack(false) })), false, '既无字幕也无文字/MG 片段');

// ── 两个调用点都必须走这个 helper,不能再各自内联 ───────────────────────────
for (const file of ['./TimelineComposition.tsx', '../components/timeline/useTimelineController.ts']) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  assert.match(source, /captionOverlayVisible\(state\)/, `${file} 必须调用共享 helper`);
  assert.doesNotMatch(
    source,
    /captionsHidden === undefined &&/,
    `${file} 不能再内联自己的 captionsHidden 回退规则`,
  );
}

console.log('caption-overlay-visibility.verify: ok (显式开关/关轨不隐藏 MG/默认分支/两端共用 helper)');
