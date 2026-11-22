import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export type GuardCode = 'invalid' | 'outside' | 'protected';

export class PathGuardError extends Error {
  constructor(
    public readonly code: GuardCode,
    message: string,
  ) {
    super(message);
  }
}

/** Pastas inteiras que o agente nunca lê nem escreve. */
const PROTECTED_DIRS = new Set(['.git', '.ssh', '.aws', '.gnupg']);

/** Nomes de arquivo com segredos: variáveis de ambiente, chaves e credenciais de gerenciadores de pacote. */
const PROTECTED_FILES = [/^\.env($|\.)/i, /\.(pem|key|p12|pfx)$/i, /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, /^\.(npmrc|netrc|pypirc)$/i];

/** No Windows, ponto e espaço no fim do nome são descartados: `.env.` e `id_rsa ` são os mesmos arquivos. */
const normalizeSegment = (s: string) => s.replace(/[. ]+$/, (m) => (m === s ? s : ''));

export function isProtectedPath(rel: string): boolean {
  const segments = rel.split(/[\\/]+/).filter((s) => s && s !== '.');
  for (const raw of segments) {
    const seg = normalizeSegment(raw).toLowerCase();
    if (PROTECTED_DIRS.has(seg)) return true;
  }
  const last = segments.at(-1);
  if (!last) return false;
  const name = normalizeSegment(last);
  return PROTECTED_FILES.some((re) => re.test(name));
}

const isUp = (rel: string) => rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);

/**
 * Transforma um caminho pedido pelo modelo em um caminho absoluto SEGURO dentro do workspace.
 * Recusa: entrada inválida, `..` e caminhos absolutos que saem, arquivos protegidos (.git, .env, chaves)
 * e links simbólicos/junctions que apontam para fora (a checagem usa o caminho real do que já existe).
 * O alvo pode ainda não existir (escrita): vale o ancestral mais próximo que existe.
 */
export async function resolveInside(root: string, input: string): Promise<string> {
  if (typeof input !== 'string' || input.length === 0 || input.length > 1024 || input.includes('\0')) {
    throw new PathGuardError('invalid', 'caminho inválido');
  }
  // Nada de fluxos alternativos do NTFS (arquivo.txt:stream): ':' só vale na letra do drive.
  const colon = input.indexOf(':');
  if (colon !== -1 && (colon !== 1 || !/^[A-Za-z]/.test(input) || input.indexOf(':', 2) !== -1)) {
    throw new PathGuardError('invalid', 'caminho inválido');
  }

  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, input);
  const rel = relative(rootAbs, abs);
  if (isUp(rel)) throw new PathGuardError('outside', 'caminho fora do workspace');
  if (rel && isProtectedPath(rel)) throw new PathGuardError('protected', 'caminho protegido: segredos e .git não podem ser acessados');

  // Links: confere o caminho REAL. Para alvo novo, sobe até o ancestral que existe.
  const realRoot = await realpath(rootAbs);
  let probe = abs;
  for (;;) {
    try {
      const real = await realpath(probe);
      const realRel = relative(realRoot, real);
      if (isUp(realRel)) throw new PathGuardError('outside', 'caminho fora do workspace');
      // O caminho real também não pode cair em área protegida (nomes curtos 8.3, links dentro do workspace).
      if (realRel && isProtectedPath(realRel)) throw new PathGuardError('protected', 'caminho protegido: segredos e .git não podem ser acessados');
      return abs;
    } catch (err) {
      if (err instanceof PathGuardError) throw err;
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = dirname(probe);
      if (parent === probe || isUp(relative(rootAbs, parent))) throw new PathGuardError('outside', 'caminho fora do workspace');
      probe = parent;
    }
  }
}

export const baseName = basename;
