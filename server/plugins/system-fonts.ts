import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

interface FontScanResult {
  ok: boolean;
  userFonts: string[];
  systemFonts: string[];
  allFonts: string[];
  timestamp: number;
}

let cachedResult: FontScanResult | null = null;
let lastDirMtimes: Record<string, number> = {};

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

    for (const baseOffset of fontOffsets) {
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
      if (!nameOffset || !nameLength || nameLength > 250000) continue;

      const nameBuf = Buffer.alloc(nameLength);
      readSync(fd, nameBuf, 0, nameLength, nameOffset);
      const count = nameBuf.readUInt16BE(2);
      const stringOffset = nameBuf.readUInt16BE(4);

      let typoFamily = '';
      let family = '';

      for (let i = 0; i < count; i++) {
        const rec = 6 + i * 12;
        if (rec + 12 > nameBuf.length) break;
        const pid = nameBuf.readUInt16BE(rec);
        const eid = nameBuf.readUInt16BE(rec + 2);
        const nid = nameBuf.readUInt16BE(rec + 6);
        const slen = nameBuf.readUInt16BE(rec + 8);
        const soff = nameBuf.readUInt16BE(rec + 10);
        const strStart = stringOffset + soff;
        if (strStart + slen > nameBuf.length) continue;

        let str = '';
        try {
          if (pid === 0 || (pid === 3 && (eid === 1 || eid === 10))) {
            str = decodeUtf16BE(nameBuf, strStart, slen);
          } else {
            str = nameBuf.toString('latin1', strStart, strStart + slen);
          }
        } catch {
          // ignore decoding errors
        }

        str = str.replace(/[\x00-\x1f]/g, '').trim();
        // Ignore internal OS fonts starting with '.'
        if (str && !str.startsWith('.') && str.length > 1) {
          if (nid === 16 && !typoFamily) typoFamily = str;
          if (nid === 1 && !family) family = str;
        }
      }
      const best = typoFamily || family;
      if (best) families.add(best);
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

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const dirStat = statSync(dir);
      mtimes[dir] = dirStat.mtimeMs;
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (/\.(ttf|otf|ttc|dfont)$/i.test(entry)) {
          const families = readFontFamiliesFromFile(join(dir, entry));
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

export function scanSystemFonts(force = false): FontScanResult {
  const { userDirs, systemDirs } = resolveFontDirectories();
  const now = Date.now();

  if (!force && cachedResult) {
    // Check if any directory mtime changed
    let mtimeChanged = false;
    for (const dir of [...userDirs, ...systemDirs]) {
      if (existsSync(dir)) {
        try {
          const s = statSync(dir);
          if (s.mtimeMs !== lastDirMtimes[dir]) {
            mtimeChanged = true;
            break;
          }
        } catch {
          // ignore
        }
      }
    }
    if (!mtimeChanged) {
      return cachedResult;
    }
  }

  const userScan = scanDirectories(userDirs);
  const systemScan = scanDirectories(systemDirs);

  const userFonts = Array.from(userScan.fonts).sort((a, b) => a.localeCompare(b));
  // System fonts excluding ones already in user fonts
  const systemFonts = Array.from(systemScan.fonts)
    .filter((f) => !userScan.fonts.has(f))
    .sort((a, b) => a.localeCompare(b));

  const allSet = new Set([...userFonts, ...systemFonts]);
  const allFonts = Array.from(allSet).sort((a, b) => a.localeCompare(b));

  lastDirMtimes = { ...userScan.mtimes, ...systemScan.mtimes };
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
