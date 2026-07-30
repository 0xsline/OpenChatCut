// The "drop-in seam" + a sandbox for evaluating templates.
//
// Templates are no-import `({item}) => JSX` arrow functions that use
// INJECTED globals. They can be AI-generated / user-supplied, so evaluating
// them is a security-critical path (arbitrary JS runs every frame).
//
// Defense in depth (two layers):
//   1. static validation — reject code containing network / storage / DOM-escape
//      / dynamic-code / infinite-loop patterns before it ever runs.
//   2. restricted scope — the eval Function shadows every reachable dangerous
//      global (window/document/fetch/eval/Function/…) with `undefined`, and runs
//      in strict mode (no implicit globals, `this` === undefined).
//
// ⚠️ This is hardening, NOT a hard VM boundary. A determined attacker could still
// reach the real global via a dynamically-computed prototype-chain constructor
// traversal that slips past the static check. PRODUCTION must additionally run
// templates in a sandboxed <iframe sandbox="allow-scripts"> (opaque origin) or a
// QuickJS WASM realm.
import * as Babel from '@babel/standalone';
import * as React from 'react';
import {
  useCurrentFrame, useVideoConfig, interpolate, interpolateColors,
  spring, Easing, random, Img as RemotionImg, Video, Audio, Sequence, AbsoluteFill, staticFile,
} from 'remotion';

export type MgItem = { props: Record<string, unknown>; width: number; height: number };
export type MgComponent = React.FC<{ item: MgItem }>;

// Scraped templates often carry a DANGLING bgImage — a bare asset id like
// "04ff45a7b0" (not a URL). In the browser Player that just 404s harmlessly, but
// under headless render Remotion's <Img> waits on delayRender() until it times  // impeccable-disable-line broken-image -- 注释中的 Remotion <Img> 提及,非真实标签
// out (fatal). So: only render an <Img> when the src is a genuinely loadable URL
// (http/https/data/blob or a root path); otherwise render nothing. For a real
// URL that still fails, onError makes Remotion swallow it instead of throwing.
const isLoadableSrc = (src: unknown): boolean =>
  typeof src === 'string' && /^(https?:|data:|blob:|\/)/.test(src.trim());

const Img: React.FC<Record<string, unknown>> = (props) =>
  isLoadableSrc(props.src)
    ? React.createElement(RemotionImg, {
        ...props,
        onError: props.onError ?? (() => undefined),
      } as React.ComponentProps<typeof RemotionImg>)
    : null;

// MG codegen（含导入的 MG）有时把纯 CSS 的驼峰属性当成 JSX 属性直接写在
// host/SVG 元素上，例如 `<rect mixBlendMode="overlay" />`。React 19 会既报警告又
// 直接丢弃它——混合模式静默失效。`mix-blend-mode` 是 CSS-only（从不是合法的 DOM/SVG
// 属性），所以在 createElement 时把它挪进 style 永远是对的：既消警告又让混合真正生效。
// 只挪这一个歧义为零的属性（filter/mask/clipPath 等是合法 SVG 属性，绝不能碰）。
const CSS_ONLY_PROPS = ['mixBlendMode'] as const;

const createElementSafe = ((type: unknown, props: unknown, ...children: unknown[]) => {
  if (typeof type === 'string' && props && typeof props === 'object') {
    const p = props as Record<string, unknown>;
    let moved: Record<string, unknown> | null = null;
    for (const key of CSS_ONLY_PROPS) {
      if (key in p) (moved ??= {})[key] = p[key];
    }
    if (moved) {
      const { style, ...rest } = p;
      // 关键：把已挪走的属性从 rest 里删掉，否则它仍作为 DOM 属性残留 → React 照样报警告。
      for (const key of CSS_ONLY_PROPS) delete (rest as Record<string, unknown>)[key];
      // 显式 style 覆盖挪过来的值（作者若同时写了 style.mixBlendMode 以其为准）。
      props = { ...rest, style: { ...moved, ...(style as object | undefined) } };
    }
  }
  return React.createElement(type as never, props as never, ...(children as React.ReactNode[]));
}) as typeof React.createElement;

// 与真 React 完全一致，仅 createElement 加上上面的 host-属性→style 归位。
// 用 Proxy 转发所有其它成员（Fragment/hooks/…），不受可枚举性影响。
const HostReact = new Proxy(React, {
  get: (target, prop, recv) => (prop === 'createElement' ? createElementSafe : Reflect.get(target, prop, recv)),
});

// The only globals a template legitimately needs (verified across all 211).
const WHITELIST: Record<string, unknown> = {
  React: HostReact, useCurrentFrame, useVideoConfig, interpolate, interpolateColors,
  spring, Easing, random, Img, Video, Audio, Sequence, AbsoluteFill, staticFile,
};

// Everything reachable that a template must NOT touch → shadowed to undefined.
// NB: 'eval' and 'arguments' are reserved in strict mode and CANNOT be
// parameter names — they are blocked by the static check instead.
const SHADOW = [
  'window', 'self', 'globalThis', 'document', 'navigator', 'location', 'history',
  'parent', 'top', 'opener', 'frames', 'Function', 'require', 'module',
  'exports', 'process', 'importScripts', 'postMessage', 'fetch', 'XMLHttpRequest',
  'WebSocket', 'EventSource', 'localStorage', 'sessionStorage', 'indexedDB',
  'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'requestAnimationFrame',
  'alert', 'prompt', 'confirm', 'open', 'Worker', 'SharedWorker', 'Notification',
];

// Layer 1: static blocklist (targets usage patterns, not bare words in comments).
const FORBIDDEN: [RegExp, string][] = [
  [/\bimport\s*[({]/, 'dynamic import()'],
  [/(^|[^.\w])import\s+[\w{*"']/m, 'import statement'],
  [/\brequire\s*\(/, 'require()'],
  [/\beval\b/, 'eval (any form)'],
  [/\barguments\b/, 'arguments'],
  [/\bnew\s+Function\b/, 'new Function'],
  [/\.\s*constructor\b/, '.constructor (escape vector)'],
  [/\bwindow\s*[.[]/, 'window access'],
  [/\bdocument\s*[.[]/, 'document access'],
  [/\bglobalThis\b/, 'globalThis'],
  [/\bfetch\s*\(/, 'fetch()'],
  [/\bnew\s+(XMLHttpRequest|WebSocket|EventSource|Worker)\b/, 'network/worker'],
  [/\b(localStorage|sessionStorage|indexedDB)\s*[.[]/, 'storage access'],
  [/\.\s*cookie\b/, 'cookie access'],
  [/\bimportScripts\b/, 'importScripts'],
  [/\b(setTimeout|setInterval)\s*\(/, 'timers'],
  [/while\s*\(\s*true\s*\)/, 'infinite loop while(true)'],
  [/for\s*\(\s*;\s*;\s*\)/, 'infinite loop for(;;)'],
  [/\bdebugger\b/, 'debugger'],
];

// strip comments so prose like "video window." doesn't trip the blocklist.
// (only used for the security scan — the original code is what actually runs.)
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

export function validateTemplate(code: string): void {
  const scan = stripComments(code);
  for (const [re, reason] of FORBIDDEN) {
    if (re.test(scan)) throw new Error(`sandbox 拒绝：检测到「${reason}」`);
  }
}

const cache = new Map<string, MgComponent>();

export function compileTemplate(code: string): MgComponent {
  const cached = cache.get(code);
  if (cached) return cached;

  validateTemplate(code); // layer 1

  // 组件识别:模板约定组件签名是 `({ item }) => JSX`,优先找参数解构里带 item 的
  // const——部分模板把工具函数写在组件前面,按"第一个 const"取会把 helper 当组件
  // 渲染(收到 {item} 原样返回 → React #31;或解构出满手 undefined → spring NaN)。
  // 找不到 item 签名再回退旧启发式(第一个 const)。
  const itemSig = code.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(\s*\{[^)}]*\bitem\b[^)}]*\}/);
  const m = itemSig ?? code.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\(|async\b|function)/);
  const name = m?.[1];
  if (!name) throw new Error('template: 找不到 `const NAME = (...)` 声明');

  const out = Babel.transform(code, { presets: [['react', { runtime: 'classic' }]], filename: 'template.jsx' });
  const transpiled = out.code;
  if (!transpiled) throw new Error('template: babel 无输出');

  // layer 2: whitelist real globals; shadow dangerous ones to undefined; strict mode.
  const names = [...Object.keys(WHITELIST), ...SHADOW];
  const values = [...Object.values(WHITELIST), ...SHADOW.map(() => undefined)];
  const factory = new Function(...names, `"use strict";\n${transpiled}\n;return ${name};`);
  const Component = factory(...values) as MgComponent;

  cache.set(code, Component);
  return Component;
}
