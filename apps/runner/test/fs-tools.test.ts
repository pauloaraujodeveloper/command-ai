import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TOOLS, runTool, toolSpecs, type ToolContext } from '../src/agent/tools.ts';

let dir: string;
const ctxFor = (kind: 'worktree' | 'readonly' | 'direct' = 'worktree'): ToolContext => ({
  workspace: { root: dir, kind },
  signal: new AbortController().signal,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ca-tools-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.ts'), 'linha um\nlinha dois\nlinha três\n');
  writeFileSync(join(dir, 'src', 'util.ts'), 'export const x = 1; // TODO: remover\n');
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), '// TODO: não deve aparecer\n');
  writeFileSync(join(dir, '.git', 'config'), 'segredo-do-git');
  writeFileSync(join(dir, '.env'), 'TOKEN=segredo');
  writeFileSync(join(dir, 'bin.dat'), Buffer.from([1, 2, 0, 3, 4]));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('especificações das ferramentas', () => {
  it('cada ferramenta tem nome, descrição e esquema estrito (sem propriedades extras)', () => {
    const specs = toolSpecs('worktree');
    expect(specs.map((s) => s.name).sort()).toEqual(['delete_file', 'edit_file', 'list_dir', 'read_file', 'run_command', 'search_files', 'write_file']);
    for (const s of specs) {
      expect(s.description.length).toBeGreaterThan(20);
      expect(s.inputSchema.type).toBe('object');
      expect(s.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('num workspace somente leitura, as ferramentas que escrevem nem são oferecidas ao modelo', () => {
    const names = toolSpecs('readonly').map((s) => s.name);
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('edit_file');
    expect(names).not.toContain('delete_file');
    expect(names).toContain('read_file');
  });
});

describe('list_dir', () => {
  it('lista arquivos e pastas, escondendo .git e entradas protegidas', async () => {
    const r = await runTool('list_dir', { path: '.' }, ctxFor());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('src/');
    expect(r.content).toContain('bin.dat');
    expect(r.content).not.toContain('.git');
    expect(r.content).not.toContain('.env');
  });
  it('devolve erro (sem lançar) para pasta inexistente ou fora do workspace', async () => {
    expect((await runTool('list_dir', { path: 'nao-existe' }, ctxFor())).isError).toBe(true);
    expect((await runTool('list_dir', { path: '..' }, ctxFor())).content).toMatch(/fora do workspace/i);
  });
});

describe('read_file', () => {
  it('lê o arquivo e permite recortar por linhas', async () => {
    expect((await runTool('read_file', { path: 'src/app.ts' }, ctxFor())).content).toContain('linha dois');
    const part = await runTool('read_file', { path: 'src/app.ts', offset: 2, limit: 1 }, ctxFor());
    expect(part.content).toContain('linha dois');
    expect(part.content).not.toContain('linha um');
    expect(part.content).not.toContain('linha três');
  });
  it('recusa arquivo protegido, binário e grande demais', async () => {
    expect((await runTool('read_file', { path: '.env' }, ctxFor())).content).toMatch(/protegido/i);
    expect((await runTool('read_file', { path: '.git/config' }, ctxFor())).isError).toBe(true);
    expect((await runTool('read_file', { path: 'bin.dat' }, ctxFor())).content).toMatch(/bin[aá]rio/i);
    writeFileSync(join(dir, 'grande.txt'), 'x'.repeat(2 * 1024 * 1024));
    expect((await runTool('read_file', { path: 'grande.txt' }, ctxFor())).content).toMatch(/grande demais/i);
  });
  it('corta saídas longas e avisa que cortou', async () => {
    writeFileSync(join(dir, 'longo.txt'), Array.from({ length: 5000 }, (_, i) => `linha ${i} ${'y'.repeat(20)}`).join('\n'));
    const r = await runTool('read_file', { path: 'longo.txt' }, ctxFor());
    expect(r.content.length).toBeLessThan(40_000);
    expect(r.content).toMatch(/cortad/i);
  });
});

describe('search_files', () => {
  it('acha texto literal com arquivo e linha, ignorando node_modules e .git', async () => {
    const r = await runTool('search_files', { query: 'TODO' }, ctxFor());
    expect(r.content).toContain('src/util.ts:1');
    expect(r.content).not.toContain('node_modules');
    const none = await runTool('search_files', { query: 'segredo-do-git' }, ctxFor());
    expect(none.content).toMatch(/nenhum/i);
  });
  it('trata a busca como texto, nunca como regex (sem risco de travar o Runner)', async () => {
    writeFileSync(join(dir, 'regex.txt'), 'a+b(c)\n');
    expect((await runTool('search_files', { query: 'a+b(c)' }, ctxFor())).content).toContain('regex.txt:1');
    expect((await runTool('search_files', { query: '(a+)+$' }, ctxFor())).content).toMatch(/nenhum/i);
  });
  it('permite ignorar maiúsculas e limita a quantidade de resultados', async () => {
    expect((await runTool('search_files', { query: 'todo', ignore_case: true }, ctxFor())).content).toContain('util.ts');
    writeFileSync(join(dir, 'muitos.txt'), Array.from({ length: 300 }, () => 'achei').join('\n'));
    const r = await runTool('search_files', { query: 'achei' }, ctxFor());
    expect(r.content.split('\n').filter((l) => l.startsWith('muitos.txt')).length).toBeLessThanOrEqual(100);
    expect(r.content).toMatch(/limite/i);
  });
});

describe('write_file, edit_file e delete_file', () => {
  it('cria arquivos (com pastas) e sobrescreve', async () => {
    const r = await runTool('write_file', { path: 'novo/dir/arq.txt', content: 'olá' }, ctxFor());
    expect(r.isError).toBeFalsy();
    expect(readFileSync(join(dir, 'novo', 'dir', 'arq.txt'), 'utf8')).toBe('olá');
    await runTool('write_file', { path: 'novo/dir/arq.txt', content: 'outro' }, ctxFor());
    expect(readFileSync(join(dir, 'novo', 'dir', 'arq.txt'), 'utf8')).toBe('outro');
  });
  it('recusa escrever em área protegida, fora do workspace, grande demais ou em workspace somente leitura', async () => {
    expect((await runTool('write_file', { path: '.env', content: 'x' }, ctxFor())).content).toMatch(/protegido/i);
    expect((await runTool('write_file', { path: '../fora.txt', content: 'x' }, ctxFor())).content).toMatch(/fora do workspace/i);
    expect((await runTool('write_file', { path: 'g.txt', content: 'x'.repeat(2 * 1024 * 1024) }, ctxFor())).content).toMatch(/grande demais/i);
    expect((await runTool('write_file', { path: 'a.txt', content: 'x' }, ctxFor('readonly'))).content).toMatch(/somente leitura/i);
    expect(existsSync(join(dir, 'a.txt'))).toBe(false);
    expect(existsSync(join(tmpdir(), 'fora.txt'))).toBe(false);
  });
  it('edit_file troca um trecho único e recusa quando há zero ou várias ocorrências', async () => {
    expect((await runTool('edit_file', { path: 'src/app.ts', old_text: 'linha dois', new_text: 'LINHA 2' }, ctxFor())).isError).toBeFalsy();
    expect(readFileSync(join(dir, 'src', 'app.ts'), 'utf8')).toContain('LINHA 2');
    const missing = await runTool('edit_file', { path: 'src/app.ts', old_text: 'não existe', new_text: 'x' }, ctxFor());
    expect(missing.isError).toBe(true);
    writeFileSync(join(dir, 'rep.txt'), 'aa aa');
    const multi = await runTool('edit_file', { path: 'rep.txt', old_text: 'aa', new_text: 'b' }, ctxFor());
    expect(multi.content).toMatch(/2 ocorr/i);
    expect(readFileSync(join(dir, 'rep.txt'), 'utf8')).toBe('aa aa'); // nada mudou
  });
  it('delete_file apaga arquivo, mas não pasta nem protegido', async () => {
    expect((await runTool('delete_file', { path: 'src/util.ts' }, ctxFor())).isError).toBeFalsy();
    expect(existsSync(join(dir, 'src', 'util.ts'))).toBe(false);
    expect((await runTool('delete_file', { path: 'src' }, ctxFor())).isError).toBe(true);
    expect(existsSync(join(dir, 'src'))).toBe(true);
    expect((await runTool('delete_file', { path: '.env' }, ctxFor())).content).toMatch(/protegido/i);
  });
});

describe('validação das entradas', () => {
  it('entrada ausente, de tipo errado ou com campo extra vira erro claro, nunca exceção', async () => {
    expect((await runTool('read_file', {}, ctxFor())).content).toMatch(/INVALID_INPUT/);
    expect((await runTool('read_file', { path: 42 }, ctxFor())).content).toMatch(/INVALID_INPUT/);
    expect((await runTool('read_file', { path: 'a', extra: true }, ctxFor())).content).toMatch(/INVALID_INPUT/);
    expect((await runTool('read_file', null, ctxFor())).content).toMatch(/INVALID_INPUT/);
    expect((await runTool('ferramenta_inexistente', {}, ctxFor())).content).toMatch(/desconhecida/i);
  });
  it('todas as ferramentas registradas são conhecidas pelo executor', () => {
    expect(Object.keys(TOOLS).sort()).toEqual(['delete_file', 'edit_file', 'list_dir', 'read_file', 'run_command', 'search_files', 'write_file']);
  });
});
