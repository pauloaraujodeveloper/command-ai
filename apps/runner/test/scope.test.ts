import { describe, expect, it } from 'vitest';
import { checkScope, compileGlob, matchesScope } from '../src/agent/scope.ts';

describe('escopo de escrita: padrões', () => {
  const ok = (pattern: string, path: string) => compileGlob(pattern).test(path);

  it('** atravessa pastas (inclusive zero níveis); * não atravessa; ? é um caractere', () => {
    expect(ok('apps/web/**', 'apps/web/src/App.tsx')).toBe(true);
    expect(ok('apps/web/**', 'apps/web/index.html')).toBe(true);
    expect(ok('apps/web/**', 'apps/api/src/x.ts')).toBe(false);
    expect(ok('apps/web/**', 'apps/webextra/x.ts')).toBe(false); // prefixo parecido não vale
    expect(ok('**/migrations/**', 'apps/api/migrations/001.sql')).toBe(true);
    expect(ok('**/migrations/**', 'migrations/001.sql')).toBe(true);
    expect(ok('**/*.sql', 'a/b/c.sql')).toBe(true);
    expect(ok('**/*.sql', 'c.sql')).toBe(true);
    expect(ok('src/*.ts', 'src/a.ts')).toBe(true);
    expect(ok('src/*.ts', 'src/sub/a.ts')).toBe(false);
    expect(ok('a?.txt', 'ab.txt')).toBe(true);
    expect(ok('a?.txt', 'a/.txt')).toBe(false);
  });

  it('padrão sem barra vale só na raiz (para qualquer nível, escreva **/nome)', () => {
    expect(ok('Dockerfile', 'Dockerfile')).toBe(true);
    expect(ok('Dockerfile', 'apps/api/Dockerfile')).toBe(false);
    expect(ok('**/Dockerfile', 'apps/api/Dockerfile')).toBe(true);
    expect(ok('*.md', 'README.md')).toBe(true);
    expect(ok('*.md', 'docs/README.md')).toBe(false);
  });

  it('não diferencia maiúsculas (NTFS), aceita barra invertida e "./" na frente do caminho', () => {
    expect(matchesScope('APPS\\Web\\src\\a.ts', ['apps/web/**'])).toBe(true);
    expect(matchesScope('./apps/web/a.ts', ['apps/web/**'])).toBe(true);
  });

  it('caracteres especiais de expressão regular no padrão são literais', () => {
    expect(ok('a+b(1).txt', 'a+b(1).txt')).toBe(true);
    expect(ok('a+b(1).txt', 'aab1.txt')).toBe(false);
    expect(ok('[x]/**', '[x]/y')).toBe(true);
    expect(ok('a.b', 'aXb')).toBe(false);
  });

  it('padrão malicioso não trava (sem retrocesso catastrófico)', () => {
    const t = Date.now();
    compileGlob('**/**/**/**/**/**/**/a').test('x/'.repeat(200) + 'b');
    expect(Date.now() - t).toBeLessThan(500);
  });
});

describe('checkScope', () => {
  it('sem lista = sem restrição; lista vazia = nada pode ser escrito', () => {
    expect(checkScope(['qualquer/coisa.ts'], undefined)).toEqual([]);
    expect(checkScope(['a.ts'], [])).toEqual(['a.ts']);
  });
  it('devolve só o que está fora de todos os padrões', () => {
    expect(checkScope(['apps/web/a.tsx', 'apps/api/b.ts', 'README.md', 'apps/web/sub/c.css'], ['apps/web/**', '*.md'])).toEqual(['apps/api/b.ts']);
  });
  it('caminho que tenta sair ("..") ou é absoluto nunca está dentro do escopo', () => {
    expect(checkScope(['../fora.txt', '/etc/x', 'C:/x.txt', 'apps/web/../api/x.ts'], ['**'])).toEqual(['../fora.txt', '/etc/x', 'C:/x.txt', 'apps/web/../api/x.ts']);
  });
});
