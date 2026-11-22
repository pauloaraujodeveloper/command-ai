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
