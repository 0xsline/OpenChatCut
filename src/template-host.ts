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
import * as React from 'react';
import {
  useCurrentFrame, useVideoConfig, interpolate, interpolateColors,
  spring, Easing, random, Img as RemotionImg, Video, Audio, Sequence, AbsoluteFill, staticFile,
} from 'remotion';

export type MgItem = { props: Record<string, unknown>; width: number; height: number };
export type MgComponent = React.FC<{ item: MgItem }>;

// Scraped templates often carry a DANGLING bgImage — a bare asset id like
// "04ff45a7b0" (not a URL). In the browser Player that just 404s harmlessly, but
// under headless render Remotion's <Img> waits on delayRender() until it times // impeccable-disable-line broken-image -- Remotion <Img> mentioned in comments, not a real tag
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

// MG codegen (including imported MG) sometimes treats pure CSS camel case properties as JSX properties and writes them directly in
// On a host/SVG element, for example `<rect mixBlendMode="overlay" />`. React 19 will report both warning and
// Just discard it - blended mode silently fails. `mix-blend-mode` is CSS-only (never legal DOM/SVG
// attribute), so it is always right to move it into style when creatingElement: both to eliminate the warning and to make the mix really effective.
// Only move this attribute with zero ambiguity (filter/mask/clipPath, etc. are legal SVG attributes and must not be touched).
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
      // Key: Delete the moved attribute from rest, otherwise it will still remain as a DOM attribute → React will still report a warning.
      for (const key of CSS_ONLY_PROPS) delete (rest as Record<string, unknown>)[key];
      // Explicit style overwrites the moved value (if the author also writes style.mixBlendMode, it shall prevail).
      props = { ...rest, style: { ...moved, ...(style as object | undefined) } };
    }
  }
  return React.createElement(type as never, props as never, ...(children as React.ReactNode[]));
}) as typeof React.createElement;

// Exactly the same as real React, only createElement plus the above host-property→style return.
// Use Proxy to forward all other members (Fragment/hooks/…), not affected by enumerability.
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
const pending = new Map<string, Promise<MgComponent>>();

function templateName(code: string): string {
  const itemSignature = code.match(
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(\s*\{[^)}]*\bitem\b[^)}]*\}/,
  );
  const fallback = code.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\(|async\b|function)/);
  const name = (itemSignature ?? fallback)?.[1];
  if (!name) throw new Error('template: 找不到 `const NAME = (...)` 声明');
  return name;
}

function evaluateTemplate(transpiled: string, name: string): MgComponent {
  const names = [...Object.keys(WHITELIST), ...SHADOW];
  const values = [...Object.values(WHITELIST), ...SHADOW.map(() => undefined)];
  const factory = new Function(...names, `"use strict";\n${transpiled}\n;return ${name};`);
  return factory(...values) as MgComponent;
}

async function compileUncached(code: string): Promise<MgComponent> {
  validateTemplate(code);
  const name = templateName(code);
  // Compiler boundary: user/plugin JSX is the only path allowed to load Babel.
  const Babel = await import('@babel/standalone');
  const output = Babel.transform(code, {
    presets: [['react', { runtime: 'classic' }]],
    filename: 'template.jsx',
  }).code;
  if (!output) throw new Error('template: babel 无输出');
  return evaluateTemplate(output, name);
}

/** Validate, compile, and cache one code-backed template before it can render. */
export function prepareTemplate(code: string): Promise<MgComponent> {
  const compiled = cache.get(code);
  if (compiled) return Promise.resolve(compiled);
  const inFlight = pending.get(code);
  if (inFlight) return inFlight;
  const promise = compileUncached(code).then(
    (component) => {
      cache.set(code, component);
      pending.delete(code);
      return component;
    },
    (error: unknown) => {
      pending.delete(code);
      throw error;
    },
  );
  pending.set(code, promise);
  return promise;
}

/** Synchronous render path. Call prepareTemplate() at a readiness boundary first. */
export function getCompiledTemplate(code: string): MgComponent {
  const compiled = cache.get(code);
  if (!compiled) throw new Error('template: 尚未完成编译');
  return compiled;
}
