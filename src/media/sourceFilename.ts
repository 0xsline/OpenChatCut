const isXml10CodePoint = (codePoint: number): boolean =>
  codePoint === 0x09
  || codePoint === 0x0a
  || codePoint === 0x0d
  || (codePoint >= 0x20 && codePoint <= 0xd7ff)
  || (codePoint >= 0xe000 && codePoint <= 0xfffd)
  || (codePoint >= 0x10000 && codePoint <= 0x10ffff);

function isXml10String(value: string): boolean {
  for (const character of value) {
    if (!isXml10CodePoint(character.codePointAt(0)!)) return false;
  }
  return true;
}

/** Remove characters that XML 1.0 cannot represent. */
export function stripInvalidXml10Characters(value: string): string {
  if (isXml10String(value)) return value;
  return [...value]
    .filter((character) => isXml10CodePoint(character.codePointAt(0)!))
    .join('');
}

/** Return an untrusted source name as a safe cross-platform basename. */
export function safeSourceFilename(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replaceAll('\\', '/');
  const separator = normalized.lastIndexOf('/');
  const basename = normalized.slice(separator + 1).trim();
  if (!basename || basename === '.' || basename === '..') return undefined;
  if (!isXml10String(basename)) return undefined;
  return basename;
}
