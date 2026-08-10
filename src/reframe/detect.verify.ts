// 纯函数 headless 自检:`npx tsx src/reframe/detect.check.ts`。
// 只测无 DOM 的纯数学(不碰真实视频/网络):focalFromEnergyGrid / magnificationForAspect /
// energyGridFromImageData / sampleFrames,并校验产出的关键帧字段落在 ReframeKeyframe 取值域。
import assert from 'node:assert';
import type { ReframeKeyframe } from '../editor/types';
import {
  focalFromEnergyGrid,
  magnificationForAspect,
  energyGridFromImageData,
  sampleFrames,
  smoothFocalPath,
  type ImageDataLike,
  type DetectedKeyframe,
} from './detect';

// —— focalFromEnergyGrid:合成高能量团 → 质心落在该格中心 ——
// 3 行 4 列,能量集中在 (row=2, col=1) → 期望 x≈(1+0.5)/4=0.375, y≈(2+0.5)/3≈0.833
const grid: number[][] = [
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [0, 9, 0, 0],
];
const f = focalFromEnergyGrid(grid);
assert.ok(Math.abs(f.x - 0.375) < 1e-9, `focal x = ${f.x}`);
assert.ok(Math.abs(f.y - 5 / 6) < 1e-9, `focal y = ${f.y}`);
// 空/全零 → 画面中心
assert.deepStrictEqual(focalFromEnergyGrid([]), { x: 0.5, y: 0.5 }, 'empty grid → center');
assert.deepStrictEqual(focalFromEnergyGrid([[0, 0], [0, 0]]), { x: 0.5, y: 0.5 }, 'all-zero grid → center');
// 焦点恒在 0..1
assert.ok(f.x >= 0 && f.x <= 1 && f.y >= 0 && f.y <= 1, 'focal in 0..1');

// —— magnificationForAspect:16:9→9:16 需放大 ~3.16 填满;同比 = 1;clamp ——
const mag916 = magnificationForAspect(1920, 1080, 1080 / 1920);
assert.ok(Math.abs(mag916 - (16 / 9) / (9 / 16)) < 1e-6, `16:9→9:16 fill = ${mag916}`);
assert.ok(mag916 > 1 && mag916 <= 16, 'reframe magnification > 1 and clamped');
assert.strictEqual(magnificationForAspect(1920, 1080, 1920 / 1080), 1, '16:9→16:9 = 1');
assert.strictEqual(magnificationForAspect(0, 0, 0.5), 1, 'invalid input → 1');
assert.ok(magnificationForAspect(10000, 1, 0.001) <= 16, 'clamped to 16');
assert.ok(magnificationForAspect(1, 10000, 0.001) >= 0.05, 'clamped ≥ 0.05');

// —— energyGridFromImageData:一块高对比棋盘格 → 该格能量最高,质心贴过去 ——
const W = 8;
const H = 4;
const data: number[] = new Array(W * H * 4).fill(0);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    // 右上区 (x>=6, y<2) 放强棋盘 → 高方差;其余纯黑 → 零方差
    const v = x >= 6 && y < 2 ? ((x + y) % 2 === 0 ? 255 : 0) : 0;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
}
const img: ImageDataLike = { data, width: W, height: H };
const eGrid = energyGridFromImageData(img, 4, 2);
const eFocal = focalFromEnergyGrid(eGrid);
assert.ok(eFocal.x > 0.5, `energy focal biases right (x=${eFocal.x})`);
assert.ok(eFocal.y < 0.5, `energy focal biases up (y=${eFocal.y})`);

// —— sampleFrames:单调递增、含首尾、受 maxSamples 约束 ——
const fs = sampleFrames(100, 15, 40);
assert.strictEqual(fs[0], 0, 'starts at 0');
assert.strictEqual(fs[fs.length - 1], 99, 'ends at last frame');
for (let i = 1; i < fs.length; i++) assert.ok(fs[i] > fs[i - 1], 'frames strictly increasing');
assert.ok(sampleFrames(100000, 1, 40).length <= 40, 'respects maxSamples cap');
assert.deepStrictEqual(sampleFrames(0, 15, 40), [], 'zero-length → no frames');

// —— 产出的关键帧记录符合 ReframeKeyframe 字段/取值域 ——
const record: DetectedKeyframe = { frame: fs[1], focalPointX: f.x, focalPointY: f.y, magnification: mag916 };
const asKeyframe: ReframeKeyframe = record; // 结构须完全匹配(编译期即校验)
assert.ok(Number.isInteger(asKeyframe.frame) && asKeyframe.frame >= 0, 'frame is non-negative int');
assert.ok(asKeyframe.focalPointX >= 0 && asKeyframe.focalPointX <= 1, 'focalPointX in 0..1');
assert.ok(asKeyframe.focalPointY >= 0 && asKeyframe.focalPointY <= 1, 'focalPointY in 0..1');
assert.ok(asKeyframe.magnification >= 0.05 && asKeyframe.magnification <= 16, 'magnification in 0.05..16');

// —— smoothFocalPath: EMA 不越界、高 smooth 更粘上一帧 ——
const jagged = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 0 }];
const sticky = smoothFocalPath(jagged, 0.8);
assert.ok(sticky[1].x < 0.5, `high smooth damps jump (x=${sticky[1].x})`);
assert.ok(sticky.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1), 'smoothed in 0..1');
const raw = smoothFocalPath(jagged, 0);
assert.deepStrictEqual(raw, jagged, 'smooth=0 preserves path');

console.log('reframe-tools.check: ok');
