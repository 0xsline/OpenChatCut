// 色度键（chroma-key）效果的独立自检。
// 不 import effects.ts —— 它的 `.frag?raw` 导入依赖 Vite 的 raw-loader，裸
// `npx tsx` 解析不了（会把 .frag 当 JS 解析报错），这里跟 fx.check.ts 一样
// 手动镜像 FX_EFFECTS['builtin:fx-chroma-key'] 的 id/props（须与 effects.ts 保持一致），
// frag 源码则用 fs 直接读文本校验契约。
// 跑法: npx tsx src/gl/fx/chroma-key.check.ts
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fxUniforms, type FxDef } from './uniforms';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 镜像 effects.ts 里的 'builtin:fx-chroma-key' 条目
const chromaKey: FxDef = {
  id: 'builtin:fx-chroma-key', name: '色度键/绿幕', desc: '', frag: '',
  props: [
    { key: 'keyColor', label: '', kind: 'color', default: [0, 1, 0], uniform: 'u_keyColor' },
    { key: 'similarity', label: '', default: 0.18, min: 0, max: 0.6 },
    { key: 'smoothness', label: '', default: 0.08, min: 0.001, max: 0.4 },
    { key: 'spill', label: '', default: 0.5, min: 0, max: 1 },
  ],
};

// 1) 默认 uniform 映射：数值 props 走 u_<key>，颜色 prop 走显式 uniform 覆盖
assert.deepStrictEqual(fxUniforms(chromaKey), {
  u_keyColor: [0, 1, 0],
  u_similarity: 0.18,
  u_smoothness: 0.08,
  u_spill: 0.5,
}, 'chroma-key 默认 uniform 映射');

// 2) 越界 override 被夹取到 [min,max]（颜色逐通道夹到 [0,1]）
assert.deepStrictEqual(
  fxUniforms(chromaKey, { similarity: 99, smoothness: -1, spill: 2, keyColor: [2, -1, 0.5] }),
  { u_keyColor: [1, 0, 0.5], u_similarity: 0.6, u_smoothness: 0.001, u_spill: 1 },
  '越界 override 被夹取',
);

// 3) frag 源码契约：与 runtime.ts renderFx 绑定的 uniform 名字对齐
const frag = readFileSync(join(__dirname, 'chroma-key.frag'), 'utf8');
assert.ok(frag.includes('#version 300 es'), '声明 GLSL 300 es');
assert.ok(frag.includes('uniform sampler2D u_input'), '引用 u_input（renderFx 绑定的输入贴图）');
assert.ok(frag.includes('in vec2 v_texCoord'), '声明 v_texCoord varying（顶点着色器提供）');
assert.ok(/\bvoid\s+main\s*\(/.test(frag), '声明 main()');
assert.ok(/\bout\s+vec4\s+fragColor\b/.test(frag), '声明 out vec4 fragColor');
assert.ok(frag.includes('fragColor ='), 'main 里写 fragColor');

// props 里每个 key 对应的 uniform 名（uniform ?? u_<key>）必须真的在 frag 里声明，
// 否则 runtime 的 setUniform 拿不到 location，效果会静默不生效
for (const p of chromaKey.props) {
  const uniformName = p.uniform ?? `u_${p.key}`;
  assert.ok(frag.includes(uniformName), `frag 声明 ${uniformName}（对应 props.${p.key}）`);
}

console.log('chroma-key.check: ok');
