// Client-facing server errors keep their sentence but must not carry the host
// filesystem layout (account name, install path).
// npx tsx server/error-scrub.verify.ts
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { clientErrorMessage, scrubInternalPaths } from './error-scrub.ts';

{
  const home = homedir();
  const scrubbed = scrubInternalPaths(`ENOENT: no such file or directory, open '${home}/Desktop/project/x.mp4'`);
  assert.ok(!scrubbed.includes(home), 'the home directory is replaced');
  assert.ok(scrubbed.includes('x.mp4'), 'the file name — the useful part — survives');
  assert.ok(scrubbed.startsWith('ENOENT: no such file'), 'the error sentence is preserved');
}

{
  const scrubbed = scrubInternalPaths("EACCES: permission denied, mkdir '/var/folders/ab/cd/media/uploads'");
  assert.ok(!scrubbed.includes('/var/folders/ab/cd'), 'absolute POSIX paths are collapsed');
  assert.ok(scrubbed.includes('uploads'), 'the last segment is kept for context');
  assert.ok(scrubbed.includes('EACCES'), 'the error code survives');
}

{
  const scrubbed = scrubInternalPaths('cannot write C:\\Users\\alice\\AppData\\OpenChatCut\\store.db');
  assert.ok(!scrubbed.includes('alice'), 'Windows user directories are collapsed');
  assert.ok(scrubbed.includes('store.db'), 'the file name survives');
}

{
  // Messages without paths must pass through untouched — these are the ones
  // the editor shows to the user verbatim.
  const plain = '共享工程库只读，修改未同步';
  assert.equal(scrubInternalPaths(plain), plain, 'path-free messages are unchanged');
  assert.equal(clientErrorMessage(new Error(plain)), plain, 'clientErrorMessage unwraps Error');
  assert.equal(clientErrorMessage('raw string'), 'raw string', 'non-Error values are stringified');
}

console.log('error-scrub.verify: ok');
