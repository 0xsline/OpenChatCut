import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { projectStoreReadAuthorized, projectStoreHttpAuthorized } from '../project-store-http-auth';

interface FontScanResult {
  ok: boolean;
  userFonts: string[];
  systemFonts: string[];
  allFonts: string[];
  timestamp: number;
}

let cachedResult: FontScanResult | null = null;

function decodeUtf16BE(buf: Buffer, start: number, len: number): string {
  try {
    const slice = Buffer.from(buf.subarray(start, start + len));
    slice.swap16();
    return slice.toString('utf16le');
  } catch {
    return '';
  }
}

function readFontFamiliesFromFile(filePath: string): string[] {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const header = Buffer.alloc(12);
    readSync(fd, header, 0, 12, 0);
    const magic = header.readUInt32BE(0);

    let fontOffsets: number[] = [0];
    if (magic === 0x74746366) { // 'ttcf' TrueType Collection
      const ttcHeader = Buffer.alloc(12);
      readSync(fd, ttcHeader, 0, 12, 0);
      const numFonts = ttcHeader.readUInt32BE(8);
      const offBuf = Buffer.alloc(Math.min(numFonts * 4, 1024));
      readSync(fd, offBuf, 0, offBuf.length, 12);
      fontOffsets = [];
      for (let i = 0; i < Math.min(numFonts, 256); i++) {
        fontOffsets.push(offBuf.readUInt32BE(i * 4));
      }
    }

    const families = new Set<string>();
    const visitedNameTables = new Set<number>();
    let remainingNameBytes = 256_000;

    for (const baseOffset of new Set(fontOffsets)) {
      if (remainingNameBytes <= 0) break;
      const tableHead = Buffer.alloc(12);
      readSync(fd, tableHead, 0, 12, baseOffset);
      const numTables = tableHead.readUInt16BE(4);
      if (numTables > 128) continue;
      const tableDirBuf = Buffer.alloc(numTables * 16);
      readSync(fd, tableDirBuf, 0, numTables * 16, baseOffset + 12);

      let nameOffset = 0;
      let nameLength = 0;
      for (let i = 0; i < numTables; i++) {
        const tag = tableDirBuf.toString('utf8', i * 16, i * 16 + 4);
        if (tag === 'name') {
          nameOffset = tableDirBuf.readUInt32BE(i * 16 + 8);
          nameLength = tableDirBuf.readUInt32BE(i * 16 + 12);
          break;
        }
      }
      if (!nameOffset || nameLength < 6 || nameLength > 250000 || visitedNameTables.has(nameOffset)) continue;
      visitedNameTables.add(nameOffset);

      const nameBuf = Buffer.alloc(nameLength);
      readSync(fd, nameBuf, 0, nameLength, nameOffset);
      const count = nameBuf.readUInt16BE(2);
      const stringOffset = nameBuf.readUInt16BE(4);

      let bestFamily = '';
      let bestScore = -1;

      for (let i = 0; i < count; i++) {
        const rec = 6 + i * 12;
        if (rec + 12 > nameBuf.length) break;
        const pid = nameBuf.readUInt16BE(rec);
        const eid = nameBuf.readUInt16BE(rec + 2);
        const language = nameBuf.readUInt16BE(rec + 4);
        const nid = nameBuf.readUInt16BE(rec + 6);
        if (nid !== 1 && nid !== 16) continue;
        const slen = nameBuf.readUInt16BE(rec + 8);
        const soff = nameBuf.readUInt16BE(rec + 10);
        const strStart = stringOffset + soff;
        const unicode = pid === 0 || (pid === 3 && (eid === 1 || eid === 10));
        if (!slen || slen > (unicode ? 320 : 160) || strStart + slen > nameBuf.length) continue;
        // Prefer canonical English names that CSS can resolve. Decode only
        // bounded family records that can improve the current candidate.
        const languageScore = pid === 3 && language === 0x0409 ? 100
          : pid === 1 && language === 0 ? 90 : pid === 0 ? 80 : 0;
        const score = languageScore + (nid === 16 ? 2 : 1);
        if (score <= bestScore) continue;
        if (slen > remainingNameBytes) { remainingNameBytes = 0; break; }
        remainingNameBytes -= slen;

        let str = '';
        try {
          if (unicode) {
            str = decodeUtf16BE(nameBuf, strStart, slen);
          } else {
            str = nameBuf.toString('latin1', strStart, strStart + slen);
          }
        } catch {
          // ignore decoding errors
        }

        str = Array.from(str).filter((char) => char.charCodeAt(0) >= 32).join('').trim();
        if (str.length > 1) {
          bestFamily = str;
          bestScore = score;
        }
      }
      if (bestFamily && !bestFamily.startsWith('.')) families.add(bestFamily);
    }
    closeSync(fd);
    return Array.from(families);
  } catch {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    return [];
  }
}

function resolveFontDirectories(): { userDirs: string[]; systemDirs: string[] } {
  const osType = platform();
  const home = homedir();

  if (osType === 'darwin') {
    return {
      userDirs: [join(home, 'Library', 'Fonts')],
      systemDirs: [
        '/Library/Fonts',
        '/System/Library/Fonts',
        '/System/Library/Fonts/Supplemental',
      ],
    };
  }

  if (osType === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    const winDir = process.env.WINDIR || 'C:\\Windows';
    return {
      userDirs: [join(localAppData, 'Microsoft', 'Windows', 'Fonts')],
      systemDirs: [join(winDir, 'Fonts')],
    };
  }

  // Linux / BSD
  return {
    userDirs: [
      join(home, '.local', 'share', 'fonts'),
      join(home, '.fonts'),
    ],
    systemDirs: [
      '/usr/share/fonts',
      '/usr/local/share/fonts',
    ],
  };
}

function scanDirectories(dirs: string[]): { fonts: Set<string>; mtimes: Record<string, number> } {
  const fonts = new Set<string>();
  const mtimes: Record<string, number> = {};

  const queue = dirs.map((dir) => ({ dir, depth: 0 }));
  const visited = new Set<string>();
  for (const { dir, depth } of queue) {
    if (depth > 8 || visited.has(dir)) continue;
    visited.add(dir);
    if (visited.size > 10000) throw new Error('Font directory scan limit exceeded');
    if (!existsSync(dir)) continue;
    try {
      const dirStat = statSync(dir);
      mtimes[dir] = dirStat.mtimeMs;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          queue.push({ dir: join(dir, entry.name), depth: depth + 1 });
        } else if ((entry.isFile() || entry.isSymbolicLink()) && /\.(ttf|otf|ttc|dfont)$/i.test(entry.name)) {
          const path = join(dir, entry.name);
          if (entry.isSymbolicLink()) {
            try { if (!statSync(path).isFile()) continue; }
            catch { continue; }
          }
          const families = readFontFamiliesFromFile(path);
          for (const fam of families) {
            fonts.add(fam);
          }
        }
      }
    } catch {
      // ignore unreadable directory
    }
  }

  return { fonts, mtimes };
}

export function scanSystemFonts(force = false, directories = resolveFontDirectories()): FontScanResult {
  const { userDirs, systemDirs } = directories;
  const now = Date.now();

  if (!force && cachedResult && now - cachedResult.timestamp < 30_000) return cachedResult;

  const userScan = scanDirectories(userDirs);
  const systemScan = scanDirectories(systemDirs);

  const userFonts = Array.from(userScan.fonts).sort((a, b) => a.localeCompare(b));
  // System fonts excluding ones already in user fonts
  const systemFonts = Array.from(systemScan.fonts)
    .filter((f) => !userScan.fonts.has(f))
    .sort((a, b) => a.localeCompare(b));

  const allSet = new Set([...userFonts, ...systemFonts]);
  const allFonts = Array.from(allSet).sort((a, b) => a.localeCompare(b));

  cachedResult = {
    ok: true,
    userFonts,
    systemFonts,
    allFonts,
    timestamp: now,
  };

  return cachedResult;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function systemFontsPlugin(): Plugin {
  return {
    name: 'openchatcut-system-fonts',
    configureServer(server) {
      server.middlewares.use('/api/system-fonts', async (req: IncomingMessage, res: ServerResponse) => {
        if (!projectStoreReadAuthorized(req) || (req.method === 'POST' && !projectStoreHttpAuthorized(req))) {
          sendJson(res, 403, { ok: false, error: 'Forbidden' });
          return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
          res.setHeader('Allow', 'GET, HEAD, POST');
          sendJson(res, 405, { ok: false, error: 'Method not allowed' });
          return;
        }
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const isRefresh = url.searchParams.get('refresh') === '1' || req.method === 'POST';
          const result = scanSystemFonts(isRefresh);
          sendJson(res, 200, result);
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            userFonts: [],
            systemFonts: [],
            allFonts: [],
          });
        }
      });
    },
  };
}
