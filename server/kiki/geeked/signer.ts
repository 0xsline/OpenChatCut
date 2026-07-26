// GeekedTest signer — GeeTest v4 crypto `w` param generator. Port of GeekedTest sign.py.
// CURRENT constants (verified working 2026-07 against KikiVoice captcha_id 5046cffe...):
//   mapping = n[1:4] → n[24:27], abo = {YYhg: "BjI0"}.
// Source: https://github.com/xKiian/GeekedTest (v1.9.6). When GeeTest updates obfuscation,
// run GeekedTest's deobfuscate.py + update these constants.
import {
  createPublicKey, createCipheriv, createHash, publicEncrypt,
  constants as cryptoConstants,
} from 'node:crypto';

const MODULUS_HEX =
  '00c1e3934d1614465b33053e7f48ee4ec87b14b95ef88947713d25eecbff7e74c7977d02dc1d9451f79dd5d1c10c29acb6a9b4d6fb7d0a0279b6719e1772565f09af627715919221aef91899cae08c0d686d748b20a3603be2318ca6bc2b59706592a9219d0bf05c9f65023a21d2330807252ae0066d59ceefa5f2748ea80bab81';

const PUB_KEY = createPublicKey({
  key: { kty: 'RSA', n: Buffer.from(MODULUS_HEX, 'hex').toString('base64url'), e: Buffer.from('010001', 'hex').toString('base64url') },
  format: 'jwk',
});

function randUid(): string {
  let r = '';
  for (let i = 0; i < 4; i++) r += Math.floor(65536 * (1 + Math.random())).toString(16).padStart(4, '0').slice(-4);
  return r;
}

function encryptSym(text: string, randomStr: string): Buffer {
  const key = Buffer.from(randomStr, 'utf8');
  const iv = Buffer.from('0000000000000000', 'utf8');
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
}

function encryptAsym(message: string): string {
  return publicEncrypt({ key: PUB_KEY, padding: cryptoConstants.RSA_PKCS1_PADDING }, Buffer.from(message, 'utf8')).toString('hex');
}

function encryptW(rawInput: string, pt: string | number | undefined): string {
  const ptStr = String(pt ?? '');
  if (!ptStr || ptStr === '0') return encodeURIComponent(rawInput);
  const uid = randUid();
  return encryptSym(rawInput, uid).toString('hex') + encryptAsym(uid);
}

interface PowDetail { hashfunc: string; version: number; bits: number; datetime: string; }
interface PowMsg { pow_msg: string; pow_sign: string; }

function generatePow(lot: string, captchaId: string, hashfunc: string, version: number, bits: number, datetime: string, empty: string): PowMsg {
  const bitRemainder = bits % 4;
  const bitDivision = Math.floor(bits / 4);
  const prefix = '0'.repeat(bitDivision);
  const powString = `${version}|${bits}|${hashfunc}|${datetime}|${captchaId}|${lot}|${empty}|`;
  // 2**bits, not (1<<bits): the bitwise form is 32-bit and wraps for bits>=31.
  const maxAttempts = Math.min(2 ** bits * 256, 4_000_000);
  for (let i = 0; i < maxAttempts; i++) {
    const h = randUid();
    const combined = powString + h;
    const hashed = createHash(hashfunc).update(combined, 'utf8').digest('hex');
    if (bitRemainder === 0) {
      if (hashed.startsWith(prefix)) return { pow_msg: powString + h, pow_sign: hashed };
    } else if (hashed.startsWith(prefix)) {
      const threshold = bitRemainder === 1 ? 7 : bitRemainder === 2 ? 3 : 1;
      // Compare the ACTUAL next hex nibble (at index = bitDivision = prefix.length) against the
      // threshold. The previous `prefix.length <= threshold` was loop-invariant (always true for
      // current bits) and ignored the remainder nibble — latent break once GeeTest sends bits%4!==0.
      if (parseInt(hashed.charAt(prefix.length), 16) <= threshold) return { pow_msg: powString + h, pow_sign: hashed };
    }
  }
  throw new Error('GeeTest pow generation exceeded attempts');
}

// ── LotParser (mapping: n[1:4] → n[24:27]) ──────────────────────────────────
type Slice = number[];
type SpecPart = Slice[];
type Spec = SpecPart[];

function parseSlice(s: string): Slice { return s.split(':').map(Number); }
function parseSpec(s: string): Spec {
  const out: Spec = [];
  for (const part of s.split('+.+')) {
    if (part.includes('+')) out.push(part.split('+').map((q) => parseSlice(/\[(.*?)\]/.exec(q)![1])));
    else out.push([parseSlice(/\[(.*?)\]/.exec(part)![1])]);
  }
  return out;
}
function buildStr(parsed: Spec, num: string): string {
  const result: string[] = [];
  for (const p of parsed) {
    const current: string[] = [];
    for (const s of p) {
      const start = s[0];
      const end = s.length > 1 ? s[1] + 1 : start + 1;
      current.push(num.slice(start, end));
    }
    result.push(current.join(''));
  }
  return result.join('.');
}

const LOT = parseSpec('n[1:4]');
const LOT_RES = parseSpec('n[24:27]');

function lotDict(lotNumber: string): Record<string, unknown> {
  const i = buildStr(LOT, lotNumber);
  const r = buildStr(LOT_RES, lotNumber);
  const parts = i.split('.');
  const a: Record<string, unknown> = {};
  let cur: Record<string, unknown> = a;
  for (let idx = 0; idx < parts.length; idx++) {
    if (idx === parts.length - 1) cur[parts[idx]] = r;
    else { cur[parts[idx]] = (cur[parts[idx]] as Record<string, unknown>) || {}; cur = cur[parts[idx]] as Record<string, unknown>; }
  }
  return a;
}

export interface GeeTestData {
  lot_number: string;
  pow_detail: PowDetail;
  payload: string;
  process_token: string;
  pt: string;
}

/**
 * Generate the GeeTest v4 `w` param (the client proof). For risk_type 'ai'/'invisible'
 * (KikiVoice), no image solve is needed — the `w` carries the (static) behavioral fingerprint.
 * When GeeTest updates obfuscation, update LOT/LOT_RES (mapping) + abo below via deobfuscate.py.
 */
export function generateW(data: GeeTestData, captchaId: string): string {
  const lot = data.lot_number;
  const pd = data.pow_detail;
  const base = {
    YYhg: 'BjI0', // abo constant (current; was jCpk:yZ7D in stale copies)
    ...generatePow(lot, captchaId, pd.hashfunc, pd.version, pd.bits, pd.datetime, ''),
    ...lotDict(lot),
    biht: '1426265548',
    device_id: '',
    em: { cp: 0, ek: '11', nt: 0, ph: 0, sc: 0, si: 0, wd: 1 },
    gee_guard: { roe: { auh: '3', aup: '3', cdc: '3', egp: '3', res: '3', rew: '3', sep: '3', snh: '3' } },
    ep: '123',
    geetest: 'captcha',
    lang: 'zh',
    lot_number: lot,
  };
  return encryptW(JSON.stringify(base), data.pt);
}
