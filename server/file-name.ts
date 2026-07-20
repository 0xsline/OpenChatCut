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
