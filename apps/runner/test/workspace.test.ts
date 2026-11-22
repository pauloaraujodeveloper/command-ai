import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PathGuardError, isProtectedPath, resolveInside } from '../src/agent/workspace.ts';

let base: string;
let root: string;
let outside: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'ca-ws-'));
  root = join(base, 'repo');
  outside = join(base, 'fora');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'x');
  writeFileSync(join(outside, 'segredo.txt'), 'SEGREDO');
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof PathGuardError ? e.code : `erro:${String(e)}`;
  }
};

describe('resolveInside', () => {
  it('resolve caminhos relativos dentro do workspace, normalizando . e ..', async () => {
    expect(await resolveInside(root, 'src/a.ts')).toBe(resolve(root, 'src', 'a.ts'));
    expect(await resolveInside(root, './src/../src/a.ts')).toBe(resolve(root, 'src', 'a.ts'));
    expect(await resolveInside(root, '.')).toBe(resolve(root));
  });

  it('aceita caminho absoluto só se estiver dentro do workspace', async () => {
    expect(await resolveInside(root, join(root, 'src', 'a.ts'))).toBe(resolve(root, 'src', 'a.ts'));
    expect(await code(resolveInside(root, join(outside, 'segredo.txt')))).toBe('outside');
  });

  it('recusa escapar com .. e caminhos absolutos de outros lugares', async () => {
    for (const p of ['..', '../fora/segredo.txt', 'src/../../fora/segredo.txt', '/etc/passwd', 'C:\\Windows\\win.ini']) {
      expect(await code(resolveInside(root, p)), p).toBe('outside');
    }
  });

  it('recusa entradas inválidas: vazia, com NUL e gigantesca', async () => {
    expect(await code(resolveInside(root, ''))).toBe('invalid');
    expect(await code(resolveInside(root, 'a\0b'))).toBe('invalid');
    expect(await code(resolveInside(root, 'a'.repeat(2000)))).toBe('invalid');
  });

  it('protege .git e arquivos de segredo, em qualquer profundidade e sem diferenciar maiúsculas', async () => {
    for (const p of ['.git/config', 'sub/.git/HEAD', '.GIT/config', '.env', 'cfg/.env.local', 'cert.pem', 'k/server.KEY', 'id_rsa', '.ssh/id_ed25519', '.npmrc', '.netrc', '.pypirc']) {
      expect(await code(resolveInside(root, p)), p).toBe('protected');
    }
  });

  it('não confunde nomes parecidos com protegidos', async () => {
    for (const p of ['.gitignore', '.github/workflows/ci.yml', 'environment.ts', '.environment', 'keyboard.ts', 'pemfile.txt', 'notes.env.md']) {
      expect(await code(resolveInside(root, p)), p).toBe('ok');
    }
  });

  it('aceita alvo que ainda não existe (para escrita) se o diretório pai está dentro', async () => {
    expect(await resolveInside(root, 'src/novo/arquivo.ts')).toBe(resolve(root, 'src', 'novo', 'arquivo.ts'));
  });

  it('um link (junction) que aponta para fora não vira porta de fuga, nem para ler nem para criar arquivo', async () => {
    const link = join(root, 'link');
    try {
      symlinkSync(outside, link, 'junction'); // junction não exige privilégio no Windows
    } catch {
      return; // sistema sem suporte a links: nada a provar aqui
    }
    expect(await code(resolveInside(root, 'link/segredo.txt'))).toBe('outside');
    expect(await code(resolveInside(root, 'link/novo.txt'))).toBe('outside');
    expect(await code(resolveInside(root, 'link'))).toBe('outside');
  });
});

describe('isProtectedPath', () => {
  it('classifica pelo caminho relativo', () => {
    expect(isProtectedPath('.git/config')).toBe(true);
    expect(isProtectedPath('a/b/.env.production')).toBe(true);
    expect(isProtectedPath('src/index.ts')).toBe(false);
  });
});
