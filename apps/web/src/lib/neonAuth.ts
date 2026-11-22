import { createAuthClient } from '@neon/auth';
import { BetterAuthReactAdapter } from '@neon/auth/react/adapters';

/** URL pública do Neon Auth (vem de NEON_AUTH_BASE_URL via vite.config). Sem ela, o botão some. */
const url = import.meta.env.VITE_NEON_AUTH_URL as string | undefined;

export const neonAuthEnabled = Boolean(url);
const client = url ? createAuthClient(url, { adapter: BetterAuthReactAdapter() }) : null;

/**
 * Entra (ou cria a conta) no Neon Auth e devolve o JWT de curta duração (15 min).
 * O token é trocado imediatamente por uma sessão HttpOnly do backend e não é guardado no navegador.
 */
export async function neonToken(
  mode: 'login' | 'register',
  input: { email: string; password: string; name: string },
): Promise<string> {
  if (!client) throw new Error('Neon Auth não está configurado.');
  const res =
    mode === 'register'
      ? await client.signUp.email({ email: input.email, password: input.password, name: input.name })
      : await client.signIn.email({ email: input.email, password: input.password });
  if (res.error) throw new Error(res.error.message ?? 'Não foi possível entrar pelo Neon Auth.');
  // O plugin JWT do Better Auth expõe GET /token como `token()`; os tipos do @neon/auth 0.8.2 ainda não o declaram.
  const jwtClient = client as unknown as { token?: () => Promise<{ data?: { token?: string } | null; error?: unknown }> };
  const tok = await jwtClient.token?.();
  const token = tok?.data?.token;
  if (!tok || tok.error || !token) throw new Error('O Neon Auth não devolveu um token.');
  return token;
}

export async function neonSignOut(): Promise<void> {
  try {
    await client?.signOut();
  } catch {
    /* o logout local já encerra a sessão do painel */
  }
}
