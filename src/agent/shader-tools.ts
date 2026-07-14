import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from './context';
import type { FxDef, FxProperty } from '../gl/fx/uniforms';
import { createMessage, MODEL } from './client';

// ═══════════════════════════════════════════════════════════════════════════
// submit_shader —— 用自然语言描述 → LLM 写一段 GLSL 片元着色器 → 静态校验（+浏览器
// 端真实编译）→ 注册为运行时自定义 per-clip fx → 返回 effectId 供 manage_effects
// add 应用。忠实源站《复刻规格-Agent工具与后端》§8 submit_shader 的 type=effect 分支
// （单 clip 效果）：「只提交不应用」，应用是另一次 manage_effects。
//
// 安全：生成物是纯 GPU 片元着色器（无 fs / 网络 / DOM 访问），风险只在「能否编译 +
// 是否符合 uniform 契约」，不是代码执行。故 gate = 静态拒绝表（空 / #include / 未知
// 采样器 / 缺 u_input / 缺输出 / 超长）+ 浏览器端真实编译校验（在浏览器执行工具时）。
//
// 契约与 runtime.ts renderFx 一致：单输入片元着色器，运行时只提供
//   sampler2D u_input（unit 0）、float u_width/u_height、vec2 u_resolution、
//   float u_aspect、float u_time，加上每个可调属性的 u_<key>。varying=v_texCoord，
//   输出=fragColor（GLSL ES 3.00）。见 src/gl/fx/crt.frag、src/gl/runtime.ts。
// ═══════════════════════════════════════════════════════════════════════════

type Args = Record<string, unknown>;

/** 工具传入的原始属性描述（不可信，buildProps 会校验/归一）。 */
interface RawProp {
  key?: unknown;
  label?: unknown;
  default?: unknown;
  min?: unknown;
  max?: unknown;
  step?: unknown;
}

// submit_shader 的属性一律是数值滑杆（float u_<key>），从 FxProperty 联合里取出
// 带 min/max 的那一支，这样 buildProps 的产物在类型上就带 min/max，无需到处窄化。
type NumberProp = Extract<FxProperty, { min: number }>;

const MAX_GLSL_LEN = 20000;                          // 片元着色器合理长度上限
const FORBIDDEN = ['#include', '#import', '#pragma import']; // 片元着色器里一律禁止

/** 去掉 LLM 可能包裹的 ```glsl ... ``` 代码围栏（同 tools.ts generateMgCode）。 */
export function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^\s*```[a-zA-Z]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

/** 静态校验生成的 GLSL：通过返回 null，否则返回中文错误原因（发回给 agent）。 */
export function validateShaderSource(glsl: string): string | null {
  const src = glsl.trim();
  if (!src) return '生成的着色器为空';
  if (src.length > MAX_GLSL_LEN) return `着色器过长（${src.length} > ${MAX_GLSL_LEN}）`;
  for (const tok of FORBIDDEN) if (src.includes(tok)) return `禁止的指令：${tok}`;
  if (!src.includes('u_input')) return '着色器必须采样输入贴图 u_input';
  if (!/\bmain\b/.test(src)) return '着色器缺少 main() 入口';
  if (!/fragColor|gl_FragColor/.test(src)) return '着色器必须写出颜色（fragColor / gl_FragColor）';
  // 运行时单输入 renderFx 只绑定 u_input 一个 sampler；声明其它 sampler2D 会采样到
  // 未绑定的纹理单元 → 拒绝（契约外的未知采样器）。
  const samplers = [...src.matchAll(/\buniform\s+sampler2D\s+(\w+)/g)].map((m) => m[1]);
  const unknown = samplers.filter((n) => n !== 'u_input');
  if (unknown.length) return `未知的采样器（运行时只提供 u_input）：${unknown.join(', ')}`;
  return null;
}

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 单条原始属性 → NumberProp（归一 min/max、把 default 夹进区间、给合理 step）。 */
function toFxProperty(p: RawProp): NumberProp {
  const key = String(p.key);
  const lo = isFiniteNum(p.min) ? p.min : 0;
  const hi = isFiniteNum(p.max) ? p.max : 1;
  const min = Math.min(lo, hi);
  const max = Math.max(lo, hi);
  const def = isFiniteNum(p.default) ? Math.min(max, Math.max(min, p.default)) : min;
  const step = isFiniteNum(p.step) && p.step > 0 ? p.step : 0.01;
  const label = typeof p.label === 'string' && p.label.trim() ? p.label.trim() : key;
  return { key, label, default: def, min, max, step };
}

/** 原始属性数组 → NumberProp[]：过滤非法 GLSL 标识符、去重、归一。纯函数、可测。 */
export function buildProps(rawProps?: RawProp[]): NumberProp[] {
  const seen = new Set<string>();
  const out: NumberProp[] = [];
  for (const p of rawProps ?? []) {
    if (!p || typeof p.key !== 'string') continue;
    if (!/^[a-zA-Z_]\w*$/.test(p.key)) continue; // key 会变成 u_<key> uniform，必须是合法标识符
    if (seen.has(p.key)) continue;
    seen.add(p.key);
    out.push(toFxProperty(p));
  }
  return out;
}

/** 生成短随机后缀，浏览器 / 任意 node 都可用。 */
function shortId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  const uuid = g.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2);
  return uuid.replace(/-/g, '').slice(0, 8);
}

function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'shader';
}

/** 组装一个自定义 FxDef（唯一 id、内嵌 frag、属性 schema）。纯函数、可测。 */
export function buildCustomFxDef(name: string, frag: string, rawProps?: RawProp[]): FxDef {
  const display = name.trim() || '自定义着色器';
  return {
    id: `custom:fx-${slugify(display)}-${shortId()}`,
    name: display,
    desc: `submit_shader 自定义效果：${display}`,
    frag,
    props: buildProps(rawProps),
  };
}

/** 浏览器端真实编译校验（片元着色器）：通过返回 null，编译失败返回 GL 日志；无 WebGL2
 *  环境（node/tsx）返回 null 跳过——静态校验已兜底。
 *  ponytail: 只编译片元着色器，足以拦住会让 GL 崩溃的语法/GLSL 错误；若日后需要抓
 *  varying 不匹配，升级为对着 runtime 顶点着色器的完整 link。 */
export function compileCheck(frag: string): string | null {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return null; // 浏览器不支持 WebGL2：交给运行时，静态校验已兜底
    const sh = gl.createShader(gl.FRAGMENT_SHADER);
    if (!sh) return null;
    gl.shaderSource(sh, frag);
    gl.compileShader(sh);
    const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS);
    const log = ok ? null : (gl.getShaderInfoLog(sh) || '着色器编译失败');
    gl.deleteShader(sh);
    return log;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** 给模型的系统提示：把运行时提供的确切 uniform / varying 契约讲清楚，只要 GLSL。 */
function shaderSystemPrompt(props: NumberProp[]): string {
  const propLines = props.length
    ? props.map((p) => `  uniform float u_${p.key}; // ${p.label}（默认 ${p.default}，范围 ${p.min}..${p.max}）`).join('\n')
    : '  (no extra adjustable uniforms)';
  return `You write ONE WebGL2 GLSL ES 3.00 fragment shader for a per-clip video effect. Output ONLY the GLSL source — no markdown fences, no prose.

The runtime runs your fragment shader over a fullscreen quad and provides EXACTLY these inputs. Declare and use ONLY these; declaring any other sampler is forbidden:
  #version 300 es
  precision highp float;
  uniform sampler2D u_input;   // the clip's current frame (RGBA, premultiplied alpha)
  uniform float u_width;       // canvas width in pixels
  uniform float u_height;      // canvas height in pixels
  uniform vec2  u_resolution;  // (u_width, u_height)
  uniform float u_aspect;      // width / height
  uniform float u_time;        // seconds since clip start (use for animation)
${propLines}
  in vec2 v_texCoord;          // UV in [0,1]
  out vec4 fragColor;          // write the final color here

Rules (MUST follow exactly):
- Begin with "#version 300 es" then "precision highp float;".
- Sample the frame with texture(u_input, v_texCoord). You MUST reference u_input and write fragColor.
- Preserve alpha: derive the output alpha from the sampled input alpha (texture(u_input, uv).a) so transparent scene areas stay transparent (premultiplied-alpha pipeline).
- Use ONLY the uniforms listed above. NO extra samplers, NO #include / #import, no external textures.
- Pure fragment-shader math only. Make the effect match the description and look clean.`;
}

export const SHADER_TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'submit_shader',
    description:
      'Generate a custom per-clip WebGL fragment-shader effect from a natural-language description. An LLM writes GLSL conforming to the runtime effect contract; it is statically validated and compile-checked, then registered as a runtime effect. Returns effectId — this only REGISTERS the effect (source submit_shader). Apply separately with edit_item adds:[{type:"effect",targetItemId,assetId:<effectId>}] (or manage_effects action=add). Use for one-off custom looks not in browse_library.',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What the effect should do visually, in one or two sentences.' },
        name: { type: 'string', description: 'Short display name for the effect (also used to derive the effect id).' },
        properties: {
          type: 'array',
          description: 'Optional adjustable numeric uniforms exposed as sliders; each becomes a u_<key> float uniform in the shader. Omit for a fixed effect.',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'GLSL identifier; becomes u_<key>.' },
              label: { type: 'string', description: 'zh UI label.' },
              default: { type: 'number' },
              min: { type: 'number' },
              max: { type: 'number' },
              step: { type: 'number' },
            },
            required: ['key'],
          },
        },
      },
      required: ['description', 'name'],
    },
  },
];

export const SHADER_TOOL_NAMES = new Set(SHADER_TOOL_SCHEMAS.map((t) => t.name));

/** 执行 submit_shader。ctx 未使用（注册是全局的，产物按 effectId 由 manage_effects 应用）。 */
export async function execShaderTool(name: string, args: Args, _ctx: AgentContext): Promise<unknown> {
  if (name !== 'submit_shader') return { error: `unknown tool ${name}` };
  const description = String(args.description ?? '').trim();
  const displayName = String(args.name ?? '').trim();
  if (!description) return { error: 'description is required' };
  if (!displayName) return { error: 'name is required' };
  const rawProps = Array.isArray(args.properties) ? (args.properties as RawProp[]) : undefined;

  // 先归一属性，据此告诉模型确切的 u_<key> uniform 名字，保证生成的着色器名对得上。
  const props = buildProps(rawProps);

  let text: string;
  try {
    const msg = await createMessage({
      model: MODEL,
      max_tokens: 8000,
      system: shaderSystemPrompt(props),
      messages: [{ role: 'user', content: description }],
    });
    text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  } catch (e) {
    return { error: `shader generation failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const glsl = stripCodeFences(text);
  const staticErr = validateShaderSource(glsl);
  if (staticErr) return { error: `generated shader rejected: ${staticErr}`, glsl };

  const compileErr = compileCheck(glsl); // 浏览器端真实编译；node/无 WebGL2 时返回 null 跳过
  if (compileErr) return { error: `shader compile failed: ${compileErr}`, glsl };

  const def: FxDef = { ...buildCustomFxDef(displayName, glsl, rawProps), desc: description.slice(0, 200) };
  try {
    // effects.ts 含 .frag?raw 导入（仅 Vite/浏览器可解析）；动态 import 让本模块在
    // node/tsx 下（.check.ts）不被污染，注册仅发生在浏览器执行工具时。
    const { registerCustomFx } = await import('../gl/fx/effects');
    registerCustomFx(def);
  } catch (e) {
    return { error: `shader registration failed: ${e instanceof Error ? e.message : String(e)}`, glsl };
  }
  return {
    ok: true,
    effectId: def.id,
    name: def.name,
    properties: props.map((p) => ({ key: p.key, default: p.default, min: p.min, max: p.max })),
    next: `Apply with manage_effects action=add assetId=${def.id} targetItemId=<clip>.`,
  };
}
