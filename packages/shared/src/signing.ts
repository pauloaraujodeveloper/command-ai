import { createHmac, timingSafeEqual } from 'node:crypto';

/** Apenas Node: usado pela API (assinar) e pelo Runner (verificar). Nunca importar no navegador. */

export interface SignedJob<T extends object = Record<string, unknown>> {
  payload: T;
  signature: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function mac(payload: object, key: string): Buffer {
  return createHmac('sha256', key).update(canonical(payload)).digest();
}

export function signJob<T extends object>(payload: T, key: string): SignedJob<T> {
  return { payload, signature: mac(payload, key).toString('base64url') };
}

export function verifyJob(job: SignedJob, key: string): boolean {
  if (typeof job?.signature !== 'string' || typeof job.payload !== 'object' || job.payload === null) return false;
  const expected = mac(job.payload, key);
  let given: Buffer;
  try {
    given = Buffer.from(job.signature, 'base64url');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}
