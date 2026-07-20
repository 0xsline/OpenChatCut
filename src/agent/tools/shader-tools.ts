import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from '../context';
import type { FxDef, FxProperty } from '../../gl/fx/uniforms';
import type { MediaAsset } from '../../editor/types';
import { createMessage, MODEL } from '../client';
import { getCustomTransition, registerCustomTransition, type CustomTransitionDef } from '../../gl/customTransitions';

// ═══════════════════════════════════════════════════════════════════════════
// submit_shader —— 用自然语言描述 → LLM 写一段 GLSL 片元着色器 → 静态校验（+浏览器
// 端真实编译）→ 注册为运行时自定义 per-clip fx → 返回 effectId 供 manage_effects
// add 应用。submit_shader 的 type=effect 分支
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

// ── type=transition：双输入转场变体（submit_shader type=transition）──────
// 转场着色器契约与 per-clip fx 不同:两个输入 u_outgoing / u_incoming + 进度 u_progress。

/** 静态校验转场着色器(双输入契约)。通过返回 null,否则返回中文原因。 */
export function validateTransitionShaderSource(glsl: string): string | null {
  const src = glsl.trim();
  if (!src) return '生成的着色器为空';
  if (src.length > MAX_GLSL_LEN) return `着色器过长（${src.length} > ${MAX_GLSL_LEN}）`;
  for (const tok of FORBIDDEN) if (src.includes(tok)) return `禁止的指令：${tok}`;
  if (!src.includes('u_outgoing')) return '转场着色器必须采样前一段 u_outgoing';
  if (!src.includes('u_incoming')) return '转场着色器必须采样后一段 u_incoming';
  if (!src.includes('u_progress')) return '转场着色器必须用进度 u_progress（0→1）驱动混合';
  if (!/\bmain\b/.test(src)) return '着色器缺少 main() 入口';
  if (!/fragColor|gl_FragColor/.test(src)) return '着色器必须写出颜色（fragColor / gl_FragColor）';
  // 运行时只绑定 u_outgoing / u_incoming 两个 sampler；其它 sampler2D 会采样未绑定单元 → 拒绝
  const samplers = [...src.matchAll(/\buniform\s+sampler2D\s+(\w+)/g)].map((m) => m[1]);
  const unknown = samplers.filter((n) => n !== 'u_outgoing' && n !== 'u_incoming');
  if (unknown.length) return `未知的采样器（运行时只提供 u_outgoing / u_incoming）：${unknown.join(', ')}`;
  return null;
}

/** 组装一个自定义转场 def(唯一 custom:tr-* id、内嵌 frag、属性 schema)。纯函数、可测。 */
export function buildCustomTransitionDef(name: string, frag: string, rawProps?: RawProp[]): CustomTransitionDef {
  const display = name.trim() || '自定义转场';
  return {
    id: `custom:tr-${slugify(display)}-${shortId()}`,
    label: display,
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

/** 给模型的系统提示（转场变体）：双输入 u_outgoing/u_incoming + u_progress 契约。 */
function transitionShaderSystemPrompt(props: NumberProp[]): string {
  const propLines = props.length
    ? props.map((p) => `  uniform float u_${p.key}; // ${p.label}（默认 ${p.default}，范围 ${p.min}..${p.max}）`).join('\n')
    : '  (no extra adjustable uniforms)';
  return `You write ONE WebGL2 GLSL ES 3.00 fragment shader for a clip-to-clip video TRANSITION. Output ONLY the GLSL source — no markdown fences, no prose.

The runtime runs your fragment shader over a fullscreen quad and provides EXACTLY these inputs. Declare and use ONLY these; declaring any other sampler is forbidden:
  #version 300 es
  precision highp float;
  uniform sampler2D u_outgoing;  // the clip LEAVING (frame A), RGBA premultiplied alpha
  uniform sampler2D u_incoming;  // the clip ENTERING (frame B), RGBA premultiplied alpha
  uniform float u_progress;      // transition progress 0.0 (fully outgoing) -> 1.0 (fully incoming)
  uniform vec2  u_resolution;    // (width, height) in pixels
  uniform float u_aspect;        // width / height
  uniform float u_time;          // seconds since timeline start (optional, for animation)
${propLines}
  in vec2 v_texCoord;            // UV in [0,1]
  out vec4 fragColor;            // write the final color here

Rules (MUST follow exactly):
- Begin with "#version 300 es" then "precision highp float;".
- Sample BOTH clips: texture(u_outgoing, v_texCoord) and texture(u_incoming, v_texCoord), and blend them driven by u_progress.
- Boundary conditions are REQUIRED: at u_progress=0.0 the output must equal the outgoing frame; at u_progress=1.0 it must equal the incoming frame.
- You MUST reference u_outgoing, u_incoming, u_progress and write fragColor.
- Preserve alpha from the sampled frames (premultiplied-alpha pipeline).
- Use ONLY the uniforms listed above. NO extra samplers, NO #include / #import, no external textures.
- Pure fragment-shader math only. Make the transition match the description and look clean.`;
}

export const SHADER_TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'submit_shader',
    description:
      'Generate a custom WebGL fragment shader from a natural-language prompt. type=effect: a per-clip effect (single input u_input) → returns effectId; apply with edit_item adds:[{type:"effect",targetItemId,assetId:<effectId>}]. type=transition: a clip-to-clip transition (two inputs u_outgoing/u_incoming + u_progress) → returns a transitionId (custom:tr-*); apply with edit_item adds:[{type:"transition",assetId:<transitionId>,incomingItemId:<later clip at the cut>}]. Either way the GLSL is statically validated + compile-checked, then registered; this call only submits/registers — applying is a separate call the agent makes after the user explicitly asks. referenceAssetIds lets the generator learn from project assets: image assets are looked at as visual inspiration; ONE effect/transition asset (kind matching type) contributes its shader code as a style reference. Use for one-off custom looks/transitions not in browse_library.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['effect', 'transition'], description: 'Whether the shader is a per-clip effect (color, blur, mask, LUT-style grade, distortion) or a between-clip transition (crossfade, wipe, slide, 3D cube).' },
        prompt: { type: 'string', minLength: 1, description: 'Natural-language description of the shader. Restate the user\'s intent in one concrete sentence — e.g. "Chromatic aberration with RGB split", "Cinematic teal-orange color grade", "Smooth crossfade with soft edge".' },
        name: { type: 'string', description: 'Asset name shown in the library. Defaults to a name derived from the prompt.' },
        referenceAssetIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Project asset ids the generator should learn from. Image asset id → model LOOKS AT it as visual inspiration (e.g. a still to match for a LUT, a screenshot to mimic for a glitch effect). Effect or transition asset id → its shader code is reused as a style reference. At most one effect/transition reference per submit, and its kind must match `type`. Pass full ids or short id prefixes.',
        },
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
      required: ['type', 'prompt'], // `description` remains a legacy runtime alias for prompt.
    },
  },
];

export const SHADER_TOOL_NAMES = new Set(SHADER_TOOL_SCHEMAS.map((t) => t.name));

// ── 参数面:required=['type','prompt'];name 缺省从 prompt 派生;description 兼容别名 ──

/** name 省略时从 prompt 派生一个短显示名（"Defaults to a name derived from the prompt"）。 */
export function deriveShaderName(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  return (flat.length > 48 ? flat.slice(0, 48).trimEnd() : flat) || '自定义着色器';
}

/** 校验并归一 submit_shader 的核心参数。纯函数、可测；错误信息面向 agent。 */
export function normalizeShaderArgs(args: Args): { kind: 'effect' | 'transition'; prompt: string; name: string } | { error: string } {
  if (args.type !== 'effect' && args.type !== 'transition') {
    return { error: 'type is required: "effect" (per-clip look) or "transition" (clip-to-clip)' };
  }
  const prompt = String(args.prompt ?? args.description ?? '').trim(); // description = legacy alias of prompt
  if (!prompt) return { error: 'prompt is required — one concrete sentence describing the shader' };
  const name = String(args.name ?? '').trim() || deriveShaderName(prompt);
  return { kind: args.type, prompt, name };
}

// ── referenceAssetIds:图片资产 → 看图作视觉参考;effect/transition → 代码风格参考 ──

export interface ShaderCodeRef { id: string; kind: 'effect' | 'transition'; label: string; frag: string }
export interface ShaderRefs { imageAssets: MediaAsset[]; codeRef: ShaderCodeRef | null }

/** effects.ts 拉 .frag?raw（仅 Vite/浏览器可解析）→ 动态 import，node/tsx 下静默不可用。 */
async function lookupFxRef(id: string): Promise<ShaderCodeRef | null> {
  if (typeof document === 'undefined') return null;
  try {
    const m = await import('../../gl/fx/effects');
    const def = m.ALL_FX[id] ?? m.CUSTOM_FX[id];
    return def ? { id: def.id, kind: 'effect', label: def.name, frag: def.frag } : null;
  } catch {
    return null;
  }
}

/** 解析 referenceAssetIds → 图片资产 + 至多 1 个代码参考。全部校验在 LLM 调用之前：
 *  资产必须存在、≤1 个 effect/transition 引用、其 kind 必须与 type 一致。 */
export async function resolveShaderRefs(
  rawIds: unknown,
  type: 'effect' | 'transition',
  ctx: AgentContext,
): Promise<ShaderRefs | { error: string }> {
  const ids = Array.isArray(rawIds)
    ? rawIds.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((s) => s.trim())
    : [];
  const refs: ShaderRefs = { imageAssets: [], codeRef: null };
  if (!ids.length) return refs;

  const assets = ctx.getDoc().assets ?? ctx.getState().assets ?? [];
  const codeRefs: ShaderCodeRef[] = [];
  for (const id of ids) {
    const asset = assets.find((a) => a.id === id) ?? assets.find((a) => a.id.startsWith(id));
    if (asset) {
      if (asset.kind === 'image' || asset.kind === 'gif') { refs.imageAssets.push(asset); continue; }
      return { error: `reference asset "${asset.name}" is ${asset.kind} — only IMAGE assets (visual inspiration) or effect/transition ids (code style reference) can be referenced` };
    }
    const tr = getCustomTransition(id);
    if (tr) { codeRefs.push({ id: tr.id, kind: 'transition', label: tr.label, frag: tr.frag }); continue; }
    const fx = await lookupFxRef(id);
    if (fx) { codeRefs.push(fx); continue; }
    return { error: `reference asset not found: "${id}" — pass a project asset id/short prefix, or an effect/transition id` };
  }
  if (codeRefs.length > 1) {
    return { error: `at most ONE effect/transition reference per submit (got ${codeRefs.length}: ${codeRefs.map((c) => c.id).join(', ')})` };
  }
  const code = codeRefs[0];
  if (code) {
    if (code.kind !== type) {
      return { error: `reference kind mismatch: "${code.id}" is a ${code.kind} but type=${type} — the code reference's kind must match type` };
    }
    refs.codeRef = code;
  }
  return refs;
}

const IMAGE_MEDIA_TYPES: Record<string, 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
};

/** 把图片参考资产读成 base64 image block（浏览器 fetch 资产字节；node 下给明确错误）。 */
async function imageBlocksOf(assets: MediaAsset[]): Promise<Anthropic.ImageBlockParam[] | { error: string }> {
  if (!assets.length) return [];
  if (typeof document === 'undefined') return { error: 'image references need the browser runtime (asset bytes are fetched from the dev server)' };
  const blocks: Anthropic.ImageBlockParam[] = [];
  for (const asset of assets) {
    try {
      const res = await fetch(asset.src);
      if (!res.ok) return { error: `failed to read reference image "${asset.name}" (${res.status})` };
      const fromHeader = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      const ext = asset.src.split('?')[0]!.split('#')[0]!.split('.').pop()?.toLowerCase() ?? '';
      const mediaType = (Object.values(IMAGE_MEDIA_TYPES) as string[]).includes(fromHeader ?? '')
        ? (fromHeader as Anthropic.Base64ImageSource['media_type'])
        : IMAGE_MEDIA_TYPES[ext];
      if (!mediaType) return { error: `reference image "${asset.name}" has an unsupported format (need jpeg/png/gif/webp)` };
      const bytes = new Uint8Array(await res.arrayBuffer());
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: btoa(bin) } });
    } catch (e) {
      return { error: `failed to read reference image "${asset.name}": ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return blocks;
}

/** 执行 submit_shader（注册是全局的，产物按 effectId/transitionId 由后续 edit 应用）。 */
export async function execShaderTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'submit_shader') return { error: `unknown tool ${name}` };
  const normalized = normalizeShaderArgs(args);
  if ('error' in normalized) return normalized;
  const { kind, prompt, name: displayName } = normalized;
  const rawProps = Array.isArray(args.properties) ? (args.properties as RawProp[]) : undefined;

  // referenceAssetIds：存在性 / ≤1 代码参考 / kind 匹配，全部在 LLM 调用之前校验。
  const refs = await resolveShaderRefs(args.referenceAssetIds, kind, ctx);
  if ('error' in refs) return refs;
  const imageBlocks = await imageBlocksOf(refs.imageAssets);
  if ('error' in imageBlocks) return imageBlocks;

  let userText = prompt;
  if (refs.codeRef) {
    userText += `\n\nStyle reference — an existing ${refs.codeRef.kind} shader "${refs.codeRef.label}". Reuse its visual techniques/style where they serve the description:\n\`\`\`glsl\n${refs.codeRef.frag}\n\`\`\``;
  }
  if (imageBlocks.length) {
    userText += '\n\nUse the attached image(s) as visual inspiration — match their palette, texture, and artifacts where relevant.';
  }

  // 先归一属性，据此告诉模型确切的 u_<key> uniform 名字，保证生成的着色器名对得上。
  const props = buildProps(rawProps);

  let text: string;
  try {
    const msg = await createMessage({
      model: MODEL,
      max_tokens: 8000,
      system: kind === 'transition' ? transitionShaderSystemPrompt(props) : shaderSystemPrompt(props),
      messages: [{ role: 'user', content: imageBlocks.length ? [...imageBlocks, { type: 'text', text: userText }] : userText }],
    });
    text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  } catch (e) {
    return { error: `shader generation failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const glsl = stripCodeFences(text);
  const staticErr = kind === 'transition' ? validateTransitionShaderSource(glsl) : validateShaderSource(glsl);
  if (staticErr) return { error: `generated shader rejected: ${staticErr}`, glsl };

  const compileErr = compileCheck(glsl); // 浏览器端真实编译；node/无 WebGL2 时返回 null 跳过
  if (compileErr) return { error: `shader compile failed: ${compileErr}`, glsl };

  if (kind === 'transition') {
    // 转场注册表是纯模块(无 .frag)→ 静态 import 即可,tsx 亦安全。
    const tdef = buildCustomTransitionDef(displayName, glsl, rawProps);
    try {
      registerCustomTransition(tdef);
    } catch (e) {
      return { error: `transition registration failed: ${e instanceof Error ? e.message : String(e)}`, glsl };
    }
    return {
      ok: true,
      transitionId: tdef.id,
      assetId: tdef.id,
      name: tdef.label,
      properties: tdef.props.map((p) => ({ key: p.key, default: p.default, min: p.min, max: p.max })),
      next: `Apply with edit_item adds:[{type:"transition",assetId:"${tdef.id}",incomingItemId:"<the later clip at the cut>"}].`,
    };
  }

  const def: FxDef = { ...buildCustomFxDef(displayName, glsl, rawProps), desc: prompt.slice(0, 200) };
  try {
    // effects.ts 含 .frag?raw 导入（仅 Vite/浏览器可解析）；动态 import 让本模块在
    // node/tsx 下（.check.ts）不被污染，注册仅发生在浏览器执行工具时。
    const { registerCustomFx } = await import('../../gl/fx/effects');
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
