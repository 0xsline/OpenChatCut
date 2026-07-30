// .cube 3D LUT 解析与加载。
// 数据按 DOMAIN_MIN/MAX 归一化到 [0,1],尺寸限 [2,64],拒绝 1D LUT。
// 纯逻辑可在 tsx 下跑;fetch 只发生在 ensureCube 调用时。

export interface CubeLut {
  size: number;
  /** size³×3 的 RGB 浮点,已按 domain 归一化到 [0,1] */
  data: Float32Array;
  title?: string;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
}

// 尺寸边界
const MIN_SIZE = 2;
const MAX_SIZE = 64;

/** 解析 .cube 文本(Adobe/IRIDAS 3D LUT)。格式错误直接 throw,信息带上下文。 */
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

// ── 加载缓存:url → 已解析 LUT(失败记 null,不重试风暴;无 LUT 就透传)──
const cache = new Map<string, CubeLut | null>();
const pending = new Map<string, Promise<CubeLut | null>>();

/** 缓存里已解析好的 LUT(未加载/加载失败 → null)。同步,供渲染热路径。 */
export function getCubeSync(url: string): CubeLut | null {
  return cache.get(url) ?? null;
}

/** 该 url 是否已有结论(成功或失败)。ClipFx 用它做首帧闸门。 */
export function cubeSettled(url: string): boolean {
  return cache.has(url);
}

/** 拉取并解析 .cube(幂等,并发合并);失败返回 null 并缓存失败态。 */
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
      cache.set(url, null); // 失败 = 透传,不反复打请求
      return null;
    } finally {
      pending.delete(url);
    }
  })();
  pending.set(url, p);
  return p;
}

/** 测试/预热注入:直接放一个已解析 LUT(或失败态)进缓存。 */
export function primeCube(url: string, lut: CubeLut | null): void {
  cache.set(url, lut);
}
