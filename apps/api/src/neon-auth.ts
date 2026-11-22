import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface NeonIdentity {
  sub: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

export type NeonVerifier = (token: string) => Promise<NeonIdentity | null>;

/**
 * Verifica o JWT emitido pelo Neon Auth (Managed Better Auth) com a chave pública do JWKS.
 * Assinatura EdDSA, emissor = origem de NEON_AUTH_BASE_URL. Qualquer falha devolve null.
 */
export function createNeonVerifier(opts: { baseUrl: string; jwksUrl: string; getKey?: JWTVerifyGetKey }): NeonVerifier {
  const keys = opts.getKey ?? createRemoteJWKSet(new URL(opts.jwksUrl), { cooldownDuration: 30_000 });
  const issuer = new URL(opts.baseUrl).origin;
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, keys, { issuer, algorithms: ['EdDSA'], clockTolerance: 5 });
      const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
      if (!payload.sub || !email) return null;
      return {
        sub: payload.sub,
        email,
        name: typeof payload.name === 'string' && payload.name ? payload.name : email.split('@')[0]!,
        emailVerified: payload.emailVerified === true || payload.email_verified === true,
      };
    } catch {
      return null;
    }
  };
}
