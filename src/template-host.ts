// The "drop-in seam": turn a raw ChatCut template (a no-import `({item}) => JSX`
// arrow function stored as a code string) into a real React/Remotion component.
//
// ChatCut templates use INJECTED globals (useCurrentFrame/spring/interpolate/…)
// instead of imports. We transpile the JSX (Babel, classic runtime → React.createElement)
// then eval it inside a scope where those globals are provided. This mirrors how
// ChatCut itself evaluates templates in a sandbox.
import * as Babel from '@babel/standalone';
import * as React from 'react';
import {
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  interpolateColors,
  spring,
  Easing,
  random,
  Img,
  Video,
  Audio,
  Sequence,
  AbsoluteFill,
  staticFile,
} from 'remotion';

export type MgItem = {
  props: Record<string, unknown>;
  width: number;
  height: number;
};
export type MgComponent = React.FC<{ item: MgItem }>;

// The exact global set ChatCut templates reference (verified across all 211).
const SCOPE: Record<string, unknown> = {
  React,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  interpolateColors,
  spring,
  Easing,
  random,
  Img,
  Video,
  Audio,
  Sequence,
  AbsoluteFill,
  staticFile,
};

const cache = new Map<string, MgComponent>();

export function compileTemplate(code: string): MgComponent {
  const cached = cache.get(code);
  if (cached) return cached;

  // 1. find the declared component name: `const NAME = ({item}) => ...`
  const m = code.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\(|\basync\b|function)/);
  const name = m?.[1];
  if (!name) throw new Error('template: could not find `const NAME = (...)` declaration');

  // 2. transpile JSX → React.createElement (classic runtime references injected `React`)
  const out = Babel.transform(code, {
    presets: [['react', { runtime: 'classic' }]],
    filename: 'template.jsx',
  });
  const transpiled = out.code;
  if (!transpiled) throw new Error('template: babel produced no output');

  // 3. eval inside the injected scope, return the component
  const keys = Object.keys(SCOPE);
  const factory = new Function(...keys, `"use strict";\n${transpiled}\n;return ${name};`);
  const Component = factory(...keys.map((k) => SCOPE[k])) as MgComponent;

  cache.set(code, Component);
  return Component;
}
