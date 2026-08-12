import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { requestShapeAllowed } from './request-shape-gate';

function req(overrides: Record<string, unknown> = {}): IncomingMessage {
  return {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: {
      host: '127.0.0.1:5199',
      origin: 'http://127.0.0.1:5199',
      'sec-fetch-site': 'same-origin',
    },
    ...overrides,
  } as unknown as IncomingMessage;
}

const ok = req();
assert.equal(requestShapeAllowed(ok), true, 'same-origin loopback write allowed');

const readOnly = req({ method: 'GET' });
assert.equal(requestShapeAllowed(readOnly), true, 'reads always allowed');

const crossSite = req({ headers: { ...ok.headers, 'sec-fetch-site': 'cross-site' } });
assert.equal(requestShapeAllowed(crossSite), false, 'cross-site write blocked');

const noOrigin = req({ headers: { host: '127.0.0.1:5199', 'sec-fetch-site': 'same-origin' } });
assert.equal(requestShapeAllowed(noOrigin), false, 'write without origin blocked');

const foreignOrigin = req({
  headers: { host: '127.0.0.1:5199', origin: 'http://evil.example', 'sec-fetch-site': 'same-origin' },
});
assert.equal(requestShapeAllowed(foreignOrigin), false, 'foreign origin blocked');

const nonLoopback = req({ socket: { remoteAddress: '10.0.0.5' } });
assert.equal(requestShapeAllowed(nonLoopback), false, 'non-loopback socket blocked');

const bearer = req({ headers: { authorization: 'Bearer abc' } });
assert.equal(requestShapeAllowed(bearer), true, 'external MCP bearer allowed through (endpoint verifies)');

console.log('request-shape-gate.verify: ok');
