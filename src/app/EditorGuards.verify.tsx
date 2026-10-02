// Runnable check: `npx tsx --tsconfig tsconfig.app.json src/app/EditorGuards.verify.tsx`.
// Issue #183: served over plain HTTP from another machine (http://192.168.x.x, often
// behind a LAN reverse proxy) the page is not a secure context, so the browser
// withholds crypto.randomUUID, crypto.subtle, WebCodecs and the async clipboard. The
// lazily loaded editor threw on import and, with no error boundary, blanked the app.
// The editor route must stop before loading there and say how to reach it —
// localhost or HTTPS — instead of pretending the media stack works over HTTP.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { EN } from '../i18n/dict/en';
import { IT } from '../i18n/dict/it';
import { RU } from '../i18n/dict/ru';
import { editorAccess } from './editorAccess';
import { EditorErrorBoundary, SecureContextRequiredView } from './EditorGuards';

type Params = Record<string, string | number>;
const LAN_ORIGIN = 'http://192.168.1.20:5199';
const CJK = /[㐀-鿿]/;
const fill = (text: string, params?: Params) =>
  text.replace(/\{(\w+)\}/g, (match, key: string) => (params && key in params ? String(params[key]) : match));

// The browser's own verdict decides; loopback HTTP and HTTPS are secure contexts.
assert.deepEqual(editorAccess(false, LAN_ORIGIN), { kind: 'insecure-context', origin: LAN_ORIGIN });
for (const origin of ['http://localhost:5199', 'http://127.0.0.1:5199', 'https://editor.example.com']) {
  assert.deepEqual(editorAccess(true, origin), { kind: 'allowed' }, `${origin} must open the editor`);
}

// The requirement screen names the remedy and the refused origin, in Chinese and in English.
const usedKeys = new Set<string>();
const chinese = (key: string, params?: Params) => {
  usedKeys.add(key);
  return fill(key, params);
};
const english = (key: string, params?: Params) => fill(EN[key] ?? key, params);
for (const translate of [chinese, english]) {
  const html = renderToStaticMarkup(
    <SecureContextRequiredView origin={LAN_ORIGIN} translate={translate} onHome={() => undefined} />,
  );
  assert.ok(html.includes(LAN_ORIGIN), 'the screen must show the origin it refused');
  assert.match(html, /http:\/\/localhost/, 'the screen must point to localhost on the host machine');
  assert.match(html, /HTTPS/, 'the screen must offer HTTPS for access from other devices');
  assert.match(html, /<button[^>]*>[^<]+<\/button>/, 'the project list must stay one click away');
  if (translate === english) assert.doesNotMatch(html, CJK, 'the English screen must be fully translated');
}

// A load or render failure inside the editor shows an error with a reload action, not a blank page.
const failure = new Error('crypto.randomUUID is not a function');
const boundaryProps = { translate: chinese, onHome: () => undefined, children: <i>editor</i> };
assert.equal(renderToStaticMarkup(<EditorErrorBoundary {...boundaryProps} />), '<i>editor</i>');
const boundary = new EditorErrorBoundary(boundaryProps);
boundary.state = EditorErrorBoundary.getDerivedStateFromError(failure);
const fallback = renderToStaticMarkup(<>{boundary.render()}</>);
assert.doesNotMatch(fallback, /<i>editor<\/i>/, 'the failed editor tree must not render');
assert.ok(fallback.includes(failure.message), 'the fallback must say what failed');
assert.match(fallback, />重新加载<\/button>/, 'the fallback must offer a reload');
assert.match(fallback, />返回工程列表<\/button>/, 'the fallback must keep the project list reachable');

const reported: unknown[][] = [];
const consoleError = console.error;
console.error = (...args: unknown[]) => { reported.push(args); };
try {
  boundary.componentDidCatch(failure, { componentStack: '\n    at Editor' });
} finally {
  console.error = consoleError;
}
assert.ok(reported.some((args) => args.includes(failure)), 'the boundary must still report the error');

// Every string both screens render is translated in each non-Chinese locale.
for (const [locale, dict] of [['en', EN], ['it', IT], ['ru', RU]] as const) {
  for (const key of usedKeys) {
    assert.ok(dict[key] && !CJK.test(dict[key]), `${locale} translation missing for ${JSON.stringify(key)}`);
  }
}

// EditorRoute decides before the lazy editor chunk is requested, and that chunk sits inside the boundary.
const appViews = readFileSync(new URL('./AppViews.tsx', import.meta.url), 'utf8');
assert.match(appViews, /editorAccess\(window\.isSecureContext, window\.location\.origin\)/,
  'EditorRoute must check the secure context before loading the editor');
assert.match(appViews, /<EditorErrorBoundary[\s\S]*<Suspense[\s\S]*<Editor\b/,
  'the lazy editor must render inside EditorErrorBoundary');

console.log('EditorGuards.verify: insecure origins get the localhost/HTTPS requirement; editor failures get a reload screen');
