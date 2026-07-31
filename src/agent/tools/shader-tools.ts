export { SHADER_TOOL_SCHEMAS, SHADER_TOOL_NAMES } from './schemas/shader-tools';
import type { AgentContext } from '../context';
import type { FxDef, FxProperty } from '../../gl/fx/uniforms';
import type { MediaAsset } from '../../editor/types';
import { generateAgentText } from '../client';
import { getCustomTransition, registerCustomTransition, type CustomTransitionDef } from '../../gl/customTransitions';

// ═══════════════════════════════════════════════════════════════════════════
// submit_shader: natural-language description → LLM-generated GLSL fragment shader → static and browser
// compilation checks → runtime custom per-clip effect registration → effectId for manage_effects.
// The type=effect branch registers without applying; manage_effects performs application separately.
//
// Generated output is a GPU-only fragment shader with no filesystem, network, or DOM access. The trust
// boundary is compilation and the uniform contract rather than arbitrary code execution. Reject empty,
// oversized, imported, or contract-breaking shaders statically, then compile them in the browser.
//
// The contract matches runtime.ts renderFx: one input fragment shader receives sampler2D u_input (unit 0),
// float u_width/u_height, vec2 u_resolution, float u_aspect, float u_time, and u_<key> for each
// adjustable property. varying=v_texCoord and output=fragColor under GLSL ES 3.00.
// See src/gl/fx/crt.frag and src/gl/runtime.ts.
// ═══════════════════════════════════════════════════════════════════════════

type Args = Record<string, unknown>;

/** The original property description passed in by the tool (not trusted, buildProps will verify/normalize). */
interface RawProp {
  key?: unknown;
  label?: unknown;
  default?: unknown;
  min?: unknown;
  max?: unknown;
  step?: unknown;
}

// submit_shader properties are numeric sliders (float u_<key>); select the FxProperty branch with
// min/max so buildProps returns those fields without repeated narrowing.
type NumberProp = Extract<FxProperty, { min: number }>;

const MAX_GLSL_LEN = 20000;                          // Reasonable upper bound for a fragment shader.
const FORBIDDEN = ['#include', '#import', '#pragma import']; // Fragment shaders never permit imports.

/** Strip an optional ```glsl ... ``` fence from LLM output, matching tools.ts generateMgCode. */
export function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^\s*```[a-zA-Z]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

/** Return null for valid generated GLSL, otherwise a Chinese error message for the agent. */
export function validateShaderSource(glsl: string): string | null {
  const src = glsl.trim();
  if (!src) return '生成的着色器为空';
  if (src.length > MAX_GLSL_LEN) return `着色器过长（${src.length} > ${MAX_GLSL_LEN}）`;
  for (const tok of FORBIDDEN) if (src.includes(tok)) return `禁止的指令：${tok}`;
  if (!src.includes('u_input')) return '着色器必须采样输入贴图 u_input';
  if (!/\bmain\b/.test(src)) return '着色器缺少 main() 入口';
  if (!/fragColor|gl_FragColor/.test(src)) return '着色器必须写出颜色（fragColor / gl_FragColor）';
  // Single-input renderFx binds only u_input; reject extra sampler2D declarations that would read unbound units.
  const samplers = [...src.matchAll(/\buniform\s+sampler2D\s+(\w+)/g)].map((m) => m[1]);
  const unknown = samplers.filter((n) => n !== 'u_input');
  if (unknown.length) return `未知的采样器（运行时只提供 u_input）：${unknown.join(', ')}`;
  return null;
}

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Single original attribute → NumberProp (normalize to min/max, put default into the interval, and give a reasonable step).*/
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

/** Original property array → NumberProp[]: filter illegal GLSL identifiers, remove duplicates, and normalize. Pure function, measurable.*/
export function buildProps(rawProps?: RawProp[]): NumberProp[] {
  const seen = new Set<string>();
  const out: NumberProp[] = [];
  for (const p of rawProps ?? []) {
    if (!p || typeof p.key !== 'string') continue;
    if (!/^[a-zA-Z_]\w*$/.test(p.key)) continue; // key will become u_<key> uniform, which must be a legal identifier
    if (seen.has(p.key)) continue;
    seen.add(p.key);
    out.push(toFxProperty(p));
  }
  return out;
}

/** Generate short random suffix, available in browser/any node.*/
function shortId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  const uuid = g.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2);
  return uuid.replace(/-/g, '').slice(0, 8);
}

function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'shader';
}

/** Assemble a custom FxDef (unique id, inline frag, attribute schema). Pure function, measurable.*/
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

// ── type=transition: double input transition variant (submit_shader type=transition)──────
// The transition shader contract is different from per-clip fx: two inputs u_outgoing / u_incoming + progress u_progress.

/** Static verification transition shader (double input contract). By returning null, otherwise return the Chinese reason.*/
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
  // Only two samplers u_outgoing / u_incoming are bound at runtime; other sampler2D will sample unbound units → reject
  const samplers = [...src.matchAll(/\buniform\s+sampler2D\s+(\w+)/g)].map((m) => m[1]);
  const unknown = samplers.filter((n) => n !== 'u_outgoing' && n !== 'u_incoming');
  if (unknown.length) return `未知的采样器（运行时只提供 u_outgoing / u_incoming）：${unknown.join(', ')}`;
  return null;
}

/** Assemble a custom transition def (unique custom:tr-* id, inline frag, attribute schema). Pure function, measurable.*/
export function buildCustomTransitionDef(name: string, frag: string, rawProps?: RawProp[]): CustomTransitionDef {
  const display = name.trim() || '自定义转场';
  return {
    id: `custom:tr-${slugify(display)}-${shortId()}`,
    label: display,
    frag,
    props: buildProps(rawProps),
  };
}

/** Browser-side real compilation verification (fragment shader): by returning null, compilation failure returns GL log; no WebGL2
 *  Environment (node/tsx) returns null and skips - static verification is complete.
 *  ponytail: Only compile fragment shaders, which is enough to prevent syntax/GLSL errors that will crash GL; if you need to catch them in the future
 *  varying mismatch, upgraded to a full link to the runtime vertex shader.*/
export function compileCheck(frag: string): string | null {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return null; // The browser does not support WebGL2: static verification is left to the runtime
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

/** System tip for models: Make clear the exact uniform / varying contracts provided by the runtime, only GLSL.*/
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

/** System prompt for models (transition variant): double input u_outgoing/u_incoming + u_progress contract.*/
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

// ── Parameter surface: required=['type','prompt']; name is derived from prompt by default; description is a compatible alias ──

/** When name is omitted, a short display name is derived from prompt ("Defaults to a name derived from the prompt").*/
export function deriveShaderName(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  return (flat.length > 48 ? flat.slice(0, 48).trimEnd() : flat) || '自定义着色器';
}

/** Verify and normalize the core parameters of submit_shader. Pure functions, testable; error messages are agent-oriented.*/
export function normalizeShaderArgs(args: Args): { kind: 'effect' | 'transition'; prompt: string; name: string } | { error: string } {
  if (args.type !== 'effect' && args.type !== 'transition') {
    return { error: 'type is required: "effect" (per-clip look) or "transition" (clip-to-clip)' };
  }
  const prompt = String(args.prompt ?? args.description ?? '').trim(); // description = legacy alias of prompt
  if (!prompt) return { error: 'prompt is required — one concrete sentence describing the shader' };
  const name = String(args.name ?? '').trim() || deriveShaderName(prompt);
  return { kind: args.type, prompt, name };
}

// ── referenceAssetIds: Image assets → Look at pictures for visual reference; effect/transition → Code style reference ──

export interface ShaderCodeRef { id: string; kind: 'effect' | 'transition'; label: string; frag: string }
export interface ShaderRefs { imageAssets: MediaAsset[]; codeRef: ShaderCodeRef | null }

/** Effects.ts pulls.frag?raw (only Vite/browser can parse) → dynamic import, silently unavailable under node/tsx.*/
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

/** Resolve referenceAssetIds → image assets + at most 1 code reference. All verification before LLM call:
 *  The asset must exist, have ≤1 effect/transition reference, and its kind must be consistent with type.*/
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

/** Read the image reference asset into base64 image block (the browser fetches the asset bytes; a clear error will be given under node). */
interface AgentImagePart {
  type: 'file';
  data: { type: 'data'; data: string };
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}

async function imageBlocksOf(assets: MediaAsset[]): Promise<AgentImagePart[] | { error: string }> {
  if (!assets.length) return [];
  if (typeof document === 'undefined') return { error: 'image references need the browser runtime (asset bytes are fetched from the dev server)' };
  const blocks: AgentImagePart[] = [];
  for (const asset of assets) {
    try {
      const res = await fetch(asset.src);
      if (!res.ok) return { error: `failed to read reference image "${asset.name}" (${res.status})` };
      const fromHeader = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      const ext = asset.src.split('?')[0]!.split('#')[0]!.split('.').pop()?.toLowerCase() ?? '';
      const mediaType = (Object.values(IMAGE_MEDIA_TYPES) as string[]).includes(fromHeader ?? '')
        ? (fromHeader as AgentImagePart['mediaType'])
        : IMAGE_MEDIA_TYPES[ext];
      if (!mediaType) return { error: `reference image "${asset.name}" has an unsupported format (need jpeg/png/gif/webp)` };
      const bytes = new Uint8Array(await res.arrayBuffer());
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      blocks.push({ type: 'file', data: { type: 'data', data: btoa(bin) }, mediaType });
    } catch (e) {
      return { error: `failed to read reference image "${asset.name}": ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return blocks;
}

/** Execute submit_shader (registration is global, the product is applied by subsequent edits according to effectId/transitionId). */
export async function execShaderTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'submit_shader') return { error: `unknown tool ${name}` };
  const normalized = normalizeShaderArgs(args);
  if ('error' in normalized) return normalized;
  const { kind, prompt, name: displayName } = normalized;
  const rawProps = Array.isArray(args.properties) ? (args.properties as RawProp[]) : undefined;

  // referenceAssetIds: Existence / ≤1 code reference / kind match, all verified before LLM call.
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

  // First normalize the attributes, and then tell the model the exact u_<key> uniform name to ensure that the generated shader names match.
  const props = buildProps(rawProps);

  let text: string;
  try {
    text = await generateAgentText({
      maxOutputTokens: 8000,
      system: kind === 'transition' ? transitionShaderSystemPrompt(props) : shaderSystemPrompt(props),
      messages: [{ role: 'user', content: imageBlocks.length ? [...imageBlocks, { type: 'text', text: userText }] : userText }],
    });
  } catch (e) {
    return { error: `shader generation failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const glsl = stripCodeFences(text);
  const staticErr = kind === 'transition' ? validateTransitionShaderSource(glsl) : validateShaderSource(glsl);
  if (staticErr) return { error: `generated shader rejected: ${staticErr}`, glsl };

  const compileErr = compileCheck(glsl); // Real compilation on the browser side; return null and skip when node/no WebGL2 is used
  if (compileErr) return { error: `shader compile failed: ${compileErr}`, glsl };

  if (kind === 'transition') {
    // The transition registry is a pure module (no.frag) → static import is sufficient, and tsx is also safe.
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
    // effects.ts contains.frag?raw import (only Vite/browser can parse); dynamic import allows this module to
    // The Node/tsx validation environment is not polluted and registration only occurs when the browser executes the tool.
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
