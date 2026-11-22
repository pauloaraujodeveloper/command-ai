import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { argon2id, argon2Verify } from 'hash-wasm';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;

/* ------------------------------ Senhas: Argon2id ------------------------------ */

export interface PasswordParams {
  /** Memória em KiB. */
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

/**
 * Padrão de produção: 64 MiB, 3 iterações, 1 thread (acima do mínimo da OWASP: 19 MiB, t=2, p=1).
 * Argon2id roda em WebAssembly (hash-wasm): não há binário nativo para compilar nem para o Windows bloquear.
 */
export const DEFAULT_PASSWORD_PARAMS: PasswordParams = { memoryKiB: 65_536, iterations: 3, parallelism: 1 };

let current: PasswordParams = { ...DEFAULT_PASSWORD_PARAMS };

/** Só para ajustar custo em testes ou ao endurecer a política. Hashes mais fracos que isto são refeitos no próximo login. */
export function setPasswordParams(params: PasswordParams): void {
  current = { ...params };
  dummy = undefined;
}

export async function hashPassword(password: string): Promise<string> {
  return argon2id({
    password,
    salt: randomBytes(16),
    parallelism: current.parallelism,
    iterations: current.iterations,
    memorySize: current.memoryKiB,
    hashLength: 32,
    outputType: 'encoded',
  });
}

/** Hashes antigos (scrypt) continuam válidos para entrar; o hash é trocado por argon2id no login bem-sucedido. */
async function verifyLegacyScrypt(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 128 * 1024 * 1024,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    if (stored.startsWith('$argon2id$')) return await argon2Verify({ password, hash: stored });
    if (stored.startsWith('scrypt$')) return await verifyLegacyScrypt(password, stored);
  } catch {
    return false; // hash malformado
  }
  return false; // vazio (conta só do Neon Auth) ou formato desconhecido
}

/** Verdadeiro para scrypt ou para argon2id com parâmetros mais fracos que a política atual. */
export function needsRehash(stored: string): boolean {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(stored);
  if (!m) return true;
  return Number(m[1]) < current.memoryKiB || Number(m[2]) < current.iterations || Number(m[3]) < current.parallelism;
}

/** Hash usado para igualar o tempo de resposta quando o usuário não existe. */
let dummy: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword('senha-que-nunca-sera-usada');
  return dummy;
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function newToken(prefix = ''): string {
  return prefix + randomBytes(32).toString('base64url');
}

/* ------------------------------ TOTP (RFC 6238) ------------------------------ */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Segredo TOTP inválido');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

const STEP_MS = 30_000;

export function totpCode(secret: string, now = Date.now(), stepSeconds = 30): string {
  const counter = Math.floor(now / 1000 / stepSeconds);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const bin =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);
  return String(bin % 1_000_000).padStart(6, '0');
}

/**
 * Número do passo de 30 s em que o código vale, ou null. Aceita o passo atual e um antes/depois
 * (tolerância de relógio). O chamador guarda o último passo usado para impedir reuso do código.
 */
export function verifyTotpStep(secret: string, code: string, now = Date.now()): number | null {
  for (const drift of [-1, 0, 1]) {
    const at = now + drift * STEP_MS;
    const expected = totpCode(secret, at);
    if (expected.length === code.length && timingSafeEqual(Buffer.from(expected), Buffer.from(code))) {
      return Math.floor(at / STEP_MS);
    }
  }
  return null;
}

export const verifyTotp = (secret: string, code: string, now = Date.now()): boolean => verifyTotpStep(secret, code, now) !== null;

export function otpauthUri(secret: string, email: string): string {
  return `otpauth://totp/Command%20AI:${encodeURIComponent(email)}?secret=${secret}&issuer=Command%20AI&digits=6&period=30`;
}
