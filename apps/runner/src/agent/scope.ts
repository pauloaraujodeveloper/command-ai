/*
 * Escopo de escrita de um agente: lista de padrões relativos ao workspace.
 *   undefined = sem restrição; [] = somente leitura.
 * Padrão sem "/" vale só na raiz ("Dockerfile"); para qualquer nível escreva "**\/Dockerfile". "**" como pasta atravessa pastas (inclusive zero níveis),
 * "*" e "?" não atravessam "/". Sem diferenciar maiúsculas (NTFS).
 * Sem expressões regulares: o casamento é por programação dinâmica (tempo polinomial), então um padrão ruim nunca trava o Runner.
 */

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
const segmentsOf = (p: string) => norm(p).split('/').filter((s) => s !== '');

/** Casa um segmento de nome com "*" e "?" (sem barras). */
function matchSegment(pat: string, name: string): boolean {
  // dp[j] = o prefixo atual do padrão casa com os j primeiros caracteres do nome
  let dp = new Array<boolean>(name.length + 1).fill(false);
  dp[0] = true;
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]!;
    const next = new Array<boolean>(name.length + 1).fill(false);
    if (c === '*') {
      next[0] = dp[0]!;
      for (let j = 1; j <= name.length; j++) next[j] = next[j - 1]! || dp[j]!;
    } else {
      for (let j = 1; j <= name.length; j++) next[j] = dp[j - 1]! && (c === '?' || c === name[j - 1]);
    }
    dp = next;
  }
  return dp[name.length]!;
}

export interface Glob {
  test(path: string): boolean;
}

/** Compila um padrão. `**` sozinho num nível = zero ou mais pastas. */
export function compileGlob(pattern: string): Glob {
  const pat = segmentsOf(pattern.toLowerCase());
  return {
    test(path: string): boolean {
      const parts = segmentsOf(path.toLowerCase());
      // ok[i][j]: os i primeiros segmentos do padrão casam com os j primeiros do caminho
      let prev = new Array<boolean>(parts.length + 1).fill(false);
      prev[0] = true;
      for (let i = 0; i < pat.length; i++) {
        const p = pat[i]!;
        const cur = new Array<boolean>(parts.length + 1).fill(false);
        if (p === '**') {
          cur[0] = prev[0]!;
          for (let j = 1; j <= parts.length; j++) cur[j] = prev[j]! || cur[j - 1]!; // zero (prev[j]) ou mais pastas (cur[j-1])
        } else {
          for (let j = 1; j <= parts.length; j++) cur[j] = prev[j - 1]! && matchSegment(p.replace(/\*\*+/g, '*'), parts[j - 1]!);
        }
        prev = cur;
      }
      return prev[parts.length]!;
    },
  };
}

/** Caminho que nunca pode estar dentro de um escopo: absoluto, com unidade ou com ".." em qualquer nível. */
const isUnsafe = (p: string) => /^([\\/]|[A-Za-z]:)/.test(p) || p.split(/[\\/]+/).includes('..');

export function matchesScope(path: string, scopes: string[]): boolean {
  if (isUnsafe(path)) return false;
  return scopes.some((s) => compileGlob(s).test(path));
}

/** Os caminhos que ficam FORA do escopo. `undefined` = sem restrição (nada fora). */
export function checkScope(paths: string[], scopes: string[] | undefined): string[] {
  if (scopes === undefined) return [];
  return paths.filter((p) => !matchesScope(p, scopes));
}
