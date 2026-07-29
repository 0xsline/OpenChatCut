// .env.local minimalist parsing (dotenv semantic subset, and envLine writing method of server/keystore.ts
// round-trip):KEY=VALUE line; if the value is wrapped in a pair of quotation marks, it will be unquoted; the unquoted value will be a comment starting from the first #.
// The Electron shell does not have vite's loadEnv, use this to feed the seedKeystore.
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1);
    } else {
      const hash = v.indexOf('#');
      if (hash !== -1) v = v.slice(0, hash).trim();
    }
    if (v) out[m[1]] = v;
  }
  return out;
}
