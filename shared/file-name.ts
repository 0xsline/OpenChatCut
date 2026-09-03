// Single source of truth for user-facing file naming, shared by both hosts on
// purpose: the browser decides the name the user sees in the export dialog and
// the server writes that name to disk. Two copies of this rule would drift the
// moment either side gained a character class the other lacked.
const FORBIDDEN_FILE_NAME_CHARS = /[/\\:*?"<>|]+/g;

function replaceControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint < 32 ? '_' : character;
  }).join('');
}

/** Preserve Unicode while replacing characters forbidden by common filesystems. */
export function sanitizeFileName(value: string, fallback: string): string {
  return replaceControlCharacters(value)
    .replace(FORBIDDEN_FILE_NAME_CHARS, '_')
    .trim() || fallback;
}
