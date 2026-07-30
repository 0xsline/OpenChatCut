// .env.local 极简解析(dotenv 语义子集,与 server/keystore.ts 的 envLine 写法
// round-trip):KEY=VALUE 行;值若被成对引号包裹则去引号;未引号值从首个 # 起为注释。
// Electron 壳没有 vite 的 loadEnv,用这份喂 seedKeystore。
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
