import assert from 'node:assert/strict';
import {
  invokeDirectoryWatch,
  reportDirectoryWatchError,
} from './directory-watch-errors.ts';

const secretPath = '/Users/private/never-expose/watched-media';
const warnings: string[] = [];
reportDirectoryWatchError(new Error(`ENOENT: ${secretPath}`), {
  emitWarning(message, options) {
    warnings.push(`${options.code}:${message}`);
  },
});
assert.deepEqual(warnings, [
  'OPENCHATCUT_DIRECTORY_WATCH:directory watch operation failed',
]);
assert.equal(warnings.join('\n').includes(secretPath), false);

let reported = '';
await assert.rejects(
  invokeDirectoryWatch(
    'start',
    async () => { throw new Error(`failed to scan ${secretPath}`); },
    (error) => { reported = error instanceof Error ? error.message : String(error); },
  ),
  (error: unknown) => error instanceof Error
    && error.message === 'unable to start directory watch'
    && !error.message.includes(secretPath),
);
assert.equal(reported.includes(secretPath), true, 'internal reporting may receive the original error');
assert.equal(warnings.join('\n').includes(secretPath), false, 'warning output must remain sanitized');

await assert.rejects(
  invokeDirectoryWatch(
    'start',
    async () => { throw new Error('the media destination cannot overlap the import directory'); },
    () => undefined,
  ),
  /selected folder overlaps the media storage directory/,
);

await assert.rejects(
  invokeDirectoryWatch(
    'start',
    async () => { throw Object.assign(new Error(`EACCES: permission denied, scandir '${secretPath}'`), { code: 'EACCES' }); },
    () => undefined,
  ),
  (error: unknown) => error instanceof Error
    && error.message === 'selected folder is not readable'
    && !error.message.includes(secretPath),
);

process.stdout.write('directory-watch-errors.verify: warning and public error redaction passed\n');
