import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTaskWorkspace } from '../src/agent/worktree.ts';

let base: string;
let repo: string;
let data: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=teste', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ca-wt-'));
  repo = join(base, 'repo');
  data = join(base, 'dados');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'original\n');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'b.ts'), 'export const b = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'inicial');
});
afterEach(() => {
  try {
    git(repo, 'worktree', 'prune');
  } catch {
    /* repo já removido */
  }
  rmSync(base, { recursive: true, force: true });
});

describe('createTaskWorkspace', () => {
  it('cria um worktree isolado com os arquivos do último commit, sem tocar na árvore do usuário', async () => {
    writeFileSync(join(repo, 'a.txt'), 'ALTERAÇÃO NÃO COMMITADA\n'); // trabalho em andamento da pessoa
    const ws = await createTaskWorkspace({ workspacePath: repo, taskId: 'exec1:t1', attempt: 1, dataDir: data });
    expect(ws.kind).toBe('worktree');
    expect(ws.root).not.toBe(repo);
    expect(readFileSync(join(ws.root, 'a.txt'), 'utf8')).toBe('original\n'); // vê o commit, não a alteração solta
    writeFileSync(join(ws.root, 'a.txt'), 'mudou pelo agente\n');
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('ALTERAÇÃO NÃO COMMITADA\n'); // a árvore do usuário continua intacta
    await ws.cleanup();
  });

  it('finalize devolve o resumo e o patch do que o agente mudou, e guarda o patch em arquivo', async () => {
    const ws = await createTaskWorkspace({ workspacePath: repo, taskId: 'exec1:t1', attempt: 1, dataDir: data });
    writeFileSync(join(ws.root, 'a.txt'), 'novo conteúdo\n');
    writeFileSync(join(ws.root, 'novo.txt'), 'arquivo novo\n');
    rmSync(join(ws.root, 'src', 'b.ts'));
    const result = await ws.finalize();
    expect(result.changedFiles).toBe(3);
    expect(result.stat).toMatch(/a\.txt/);
    expect(result.patch).toContain('+novo conteúdo');
    expect(result.patch).toContain('novo.txt');
    expect(result.patch).toContain('-export const b = 1;');
    expect(result.patchFile && existsSync(result.patchFile)).toBe(true);
    expect(readFileSync(result.patchFile!, 'utf8')).toContain('+novo conteúdo');
  });

  it('sem mudanças: finalize avisa que nada mudou e cleanup remove o worktree; com mudanças o worktree fica para revisão', async () => {
    const clean = await createTaskWorkspace({ workspacePath: repo, taskId: 'exec1:t1', attempt: 1, dataDir: data });
    const r0 = await clean.finalize();
    expect(r0.changedFiles).toBe(0);
    await clean.cleanup();
    expect(existsSync(clean.root)).toBe(false);

    const dirty = await createTaskWorkspace({ workspacePath: repo, taskId: 'exec2:t1', attempt: 1, dataDir: data });
    writeFileSync(join(dirty.root, 'x.txt'), 'x');
    await dirty.finalize();
    await dirty.cleanup();
    expect(existsSync(join(dirty.root, 'x.txt'))).toBe(true); // mantido: há trabalho a revisar
  });

  it('cada tentativa tem o seu worktree e uma nova tentativa recomeça limpa', async () => {
    const first = await createTaskWorkspace({ workspacePath: repo, taskId: 'exec1:t1', attempt: 1, dataDir: data });
    writeFileSync(join(first.root, 'resto.txt'), 'sobra da tentativa 1');
    const again = await createTaskWorkspace({ workspacePath: repo, taskId: 'exec1:t1', attempt: 1, dataDir: data }); // mesma tentativa reexecutada
    expect(existsSync(join(again.root, 'resto.txt'))).toBe(false);
    const next = await createTaskWorkspace({ workspacePath: repo, taskId: 'exec1:t1', attempt: 2, dataDir: data });
    expect(next.root).not.toBe(again.root);
  });

  it('não executa hooks do Git do repositório do usuário ao criar o worktree', async () => {
    const marker = join(base, 'hook-rodou.txt');
    const hook = join(repo, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, `#!/bin/sh\necho rodou > "${marker.replace(/\\/g, '/')}"\n`, { mode: 0o755 });
    const ws = await createTaskWorkspace({ workspacePath: repo, taskId: 'exec1:t1', attempt: 1, dataDir: data });
    expect(existsSync(marker)).toBe(false);
    await ws.cleanup();
  });

  it('pasta que não é repositório Git: somente leitura por padrão, escrita direta só com permissão explícita', async () => {
    const plain = join(base, 'plain');
    mkdirSync(plain);
    writeFileSync(join(plain, 'f.txt'), 'f');
    const ro = await createTaskWorkspace({ workspacePath: plain, taskId: 't', attempt: 1, dataDir: data });
    expect(ro.kind).toBe('readonly');
    expect(ro.root).toBe(plain);
    const direct = await createTaskWorkspace({ workspacePath: plain, taskId: 't', attempt: 1, dataDir: data, allowDirectWrites: true });
    expect(direct.kind).toBe('direct');
  });

  it('repositório sem nenhum commit também cai no modo somente leitura', async () => {
    const empty = join(base, 'vazio');
    mkdirSync(empty);
    git(empty, 'init', '-q');
    const ws = await createTaskWorkspace({ workspacePath: empty, taskId: 't', attempt: 1, dataDir: data });
    expect(ws.kind).toBe('readonly');
  });

  it('sanitiza o id da tarefa no nome da pasta (nada de .. ou separadores)', async () => {
    const ws = await createTaskWorkspace({ workspacePath: repo, taskId: '../../x:..\\y', attempt: 1, dataDir: data });
    expect(ws.root.startsWith(join(data, 'worktrees'))).toBe(true);
    await ws.cleanup();
  });
});

describe('encadeamento: uma tarefa parte do resultado da anterior', () => {
  const mk = (taskId: string, baseCommits?: string[]) => createTaskWorkspace({ workspacePath: repo, taskId, attempt: 1, dataDir: data, baseCommits });
  const head = () => git(repo, 'rev-parse', 'HEAD').trim();

  it('finalize registra o resultado num commit e numa referência própria, sem mexer no branch nem na árvore da pessoa', async () => {
    const before = head();
    const ws = await mk('e1:a');
    writeFileSync(join(ws.root, 'novo.txt'), 'do agente\n');
    const fin = await ws.finalize();
    expect(fin.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(fin.commit).not.toBe(before);
    expect(git(repo, 'rev-parse', 'refs/command-ai/e1_a-a1').trim()).toBe(fin.commit);
    expect(head()).toBe(before); // o branch da pessoa não andou
    expect(git(repo, 'status', '--porcelain').trim()).toBe(''); // árvore dela intacta
    expect(existsSync(join(repo, 'novo.txt'))).toBe(false);
    await ws.cleanup();
  });

  it('a tarefa seguinte enxerga o trabalho da anterior, e o patch dela traz só o que ela mesma mudou', async () => {
    const a = await mk('e1:a');
    writeFileSync(join(a.root, 'de-a.txt'), 'A\n');
    const finA = await a.finalize();
    const b = await mk('e1:b', [finA.commit!]);
    expect(readFileSync(join(b.root, 'de-a.txt'), 'utf8')).toBe('A\n');
    writeFileSync(join(b.root, 'de-b.txt'), 'B\n');
    const finB = await b.finalize();
    expect(finB.changedFiles).toBe(1);
    expect(finB.patch).toContain('de-b.txt');
    expect(finB.patch).not.toContain('de-a.txt');
    // o commit final acumula as duas
    expect(git(repo, 'ls-tree', '-r', '--name-only', finB.commit!)).toContain('de-a.txt');
    await a.cleanup();
    await b.cleanup();
  });

  it('sem mudanças, o commit devolvido é o da base (as dependentes continuam do mesmo ponto)', async () => {
    const a = await mk('e1:a');
    writeFileSync(join(a.root, 'de-a.txt'), 'A\n');
    const finA = await a.finalize();
    const b = await mk('e1:b', [finA.commit!]);
    const finB = await b.finalize();
    expect(finB.changedFiles).toBe(0);
    expect(finB.commit).toBe(finA.commit);
    await a.cleanup();
    await b.cleanup();
  });

  it('commit que este Runner não tem: parte do HEAD e avisa', async () => {
    const ws = await mk('e1:b', ['f'.repeat(40)]);
    expect(ws.baseNote).toMatch(/não encontrado/i);
    expect(readFileSync(join(ws.root, 'a.txt'), 'utf8')).toBe('original\n');
    await ws.cleanup();
  });

  it('entrada que não é commit (opção do git, nome de ramo) nunca chega ao git', async () => {
    for (const bad of ['--upload-pack=calc', 'main', 'HEAD~1', '../x']) {
      const ws = await mk(`e1:${bad.replace(/\W/g, '')}`, [bad]);
      expect(ws.baseNote).toMatch(/inválid|não encontrado/i);
      await ws.cleanup();
    }
  });

  it('duas dependências com arquivos diferentes são combinadas', async () => {
    const a = await mk('e1:a');
    writeFileSync(join(a.root, 'de-a.txt'), 'A\n');
    const finA = await a.finalize();
    const c = await mk('e1:c');
    writeFileSync(join(c.root, 'de-c.txt'), 'C\n');
    const finC = await c.finalize();
    const d = await mk('e1:d', [finA.commit!, finC.commit!]);
    expect(existsSync(join(d.root, 'de-a.txt'))).toBe(true);
    expect(existsSync(join(d.root, 'de-c.txt'))).toBe(true);
    await a.cleanup();
    await c.cleanup();
    await d.cleanup();
  });

  it('duas dependências que mexem na mesma linha: falha com mensagem de conflito e não deixa worktree', async () => {
    const a = await mk('e1:a');
    writeFileSync(join(a.root, 'a.txt'), 'versão do A\n');
    const finA = await a.finalize();
    const c = await mk('e1:c');
    writeFileSync(join(c.root, 'a.txt'), 'versão do C\n');
    const finC = await c.finalize();
    await expect(mk('e1:d', [finA.commit!, finC.commit!])).rejects.toThrow(/conflito/i);
    expect(existsSync(join(data, 'worktrees', 'e1_d-a1'))).toBe(false);
    await a.cleanup();
    await c.cleanup();
  });
});
