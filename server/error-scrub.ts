import { homedir } from 'node:os';

// Server errors are surfaced to the user (the editor shows "共享工程库只读…"
// and upload failures verbatim), so the text itself is worth keeping. What is
// NOT worth sending is the filesystem layout: fs errors embed absolute paths
// like /Users/<name>/… or C:\Users\<name>\…, which leaks the account name and
// install location into the browser and into any log the page collects.
//
// So: scrub paths, keep the sentence.

const HOME = homedir();

/** Replace absolute filesystem paths in a message with short placeholders. */
export function scrubInternalPaths(message: string): string {
  let out = message;
  if (HOME && HOME.length > 3) {
    out = out.split(HOME).join('~');
  }
  // POSIX absolute paths: keep the final segment (usually the interesting part,
  // e.g. the file name) and drop the directories leading to it.
  out = out.replace(/(^|[\s"'(<])\/(?:[\w.+-]+\/)+([\w.+-]+)/g, (_match, prefix: string, tail: string) => (
    `${prefix}…/${tail}`
  ));
  // Windows absolute paths.
  out = out.replace(/(^|[\s"'(<])[A-Za-z]:\\(?:[^\\\s"']+\\)+([^\\\s"']+)/g, (_match, prefix: string, tail: string) => (
    `${prefix}…\\${tail}`
  ));
  return out;
}

/** Message for a client-facing error response: real text, no host paths. */
export function clientErrorMessage(error: unknown): string {
  return scrubInternalPaths(error instanceof Error ? error.message : String(error));
}
