// .cube 3D LUT parsing and loading.
// Data normalized to [0,1] by DOMAIN_MIN/MAX, size limit [2,64], reject 1D LUT.
// Pure logic can be run under tsx; fetch only occurs when ensureCube is called.

export interface CubeLut {
  size: number;
  /** RGB floating point of size³×3, normalized to [0,1] according to domain */
  data: Float32Array;
  title?: string;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
}

// size bounds
const MIN_SIZE = 2;
const MAX_SIZE = 64;

/** Parse .cube text (Adobe/IRIDAS 3D LUT). Format errors are directly thrown, and the information has context. */
export function parseCube(text: string): CubeLut {
  let size: number | null = null;
  let title: string | undefined;
  const domainMin: [number, number, number] = [0, 0, 0];
  const domainMax: [number, number, number] = [1, 1, 1];
  const values: number[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('TITLE')) {
      const m = line.match(/^TITLE\s+"(.*)"\s*$/);
      if (m) title = m[1];
      continue;
    }
    if (line.startsWith('LUT_3D_SIZE')) {
      const n = Number(line.split(/\s+/)[1]);
      if (!Number.isInteger(n) || n < MIN_SIZE || n > MAX_SIZE) {
        throw new Error(`Invalid LUT_3D_SIZE ${line.split(/\s+/)[1]} (must be integer in [${MIN_SIZE}, ${MAX_SIZE}])`);
      }
      size = n;
      continue;
    }
    if (line.startsWith('LUT_1D_SIZE')) throw new Error('1D LUT (.cube LUT_1D_SIZE) not supported');
    if (line.startsWith('DOMAIN_MIN') || line.startsWith('DOMAIN_MAX')) {
      const parts = line.split(/\s+/).slice(1).map(Number);
      if (parts.length !== 3 || parts.some(Number.isNaN)) throw new Error(`Malformed ${line.split(/\s+/)[0]}: ${line}`);
      const target = line.startsWith('DOMAIN_MIN') ? domainMin : domainMax;
      target[0] = parts[0]; target[1] = parts[1]; target[2] = parts[2];
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length !== 3) throw new Error(`Expected 3 floats per data line, got ${parts.length}: "${line}"`);
    for (const p of parts) {
      const n = Number(p);
      if (Number.isNaN(n)) throw new Error(`Non-numeric value: "${p}"`);
      values.push(n);
    }
  }

  if (size === null) throw new Error('Missing LUT_3D_SIZE header');
  const expected = size * size * size * 3;
  if (values.length !== expected) throw new Error(`Expected ${expected} values for ${size}³ LUT, got ${values.length}`);
  const span: [number, number, number] = [domainMax[0] - domainMin[0], domainMax[1] - domainMin[1], domainMax[2] - domainMin[2]];
  if (span[0] <= 0 || span[1] <= 0 || span[2] <= 0) {
    throw new Error('DOMAIN_MAX must be strictly greater than DOMAIN_MIN on every channel');
  }
  const data = new Float32Array(expected);
  for (let i = 0; i < values.length; i += 3) {
    data[i] = (values[i] - domainMin[0]) / span[0];
    data[i + 1] = (values[i + 1] - domainMin[1]) / span[1];
    data[i + 2] = (values[i + 2] - domainMin[2]) / span[2];
  }
  return { size, data, title, domainMin, domainMax };
}

// ── Load cache: url → Parsed LUT (failure will be null, no retry storm; no LUT, transparent transmission)──
const cache = new Map<string, CubeLut | null>();
const pending = new Map<string, Promise<CubeLut | null>>();

/** The parsed LUT in the cache (not loaded/failed to load → null). Synchronized, hot paths for rendering.*/
export function getCubeSync(url: string): CubeLut | null {
  return cache.get(url) ?? null;
}

/** Whether the url has a conclusion (success or failure). ClipFx uses this as a first frame gate.*/
export function cubeSettled(url: string): boolean {
  return cache.has(url);
}

/** Pull and parse.cube (idempotent, concurrent merge); return null on failure and cache the failure status.*/
export function ensureCube(url: string): Promise<CubeLut | null> {
  if (cache.has(url)) return Promise.resolve(cache.get(url) ?? null);
  const inflight = pending.get(url);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const lut = parseCube(await res.text());
      cache.set(url, lut);
      return lut;
    } catch (err) {
      console.error(`[cube-lut] ${url}:`, err);
      cache.set(url, null); // Failure = transparent transmission, no repeated requests
      return null;
    } finally {
      pending.delete(url);
    }
  })();
  pending.set(url, p);
  return p;
}

/** Test/warm injection: Put a parsed LUT (or failed state) directly into the cache.*/
export function primeCube(url: string, lut: CubeLut | null): void {
  cache.set(url, lut);
}
