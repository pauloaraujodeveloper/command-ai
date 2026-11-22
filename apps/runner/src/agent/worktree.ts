import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { WorkspaceKind } from './tools.ts';

const execFileAsync = promisify(execFile);

export interface FinalizeResult {
  changedFiles: number;
  stat: string;
  /** Patch (truncado para caber no relatório). O completo vai para `patchFile`. */
  patch: string;
  patchFile: string | null;
  /**
   * Commit com o estado do workspace ao fim da tarefa (a base, se nada mudou). Fica numa referência
   * `refs/command-ai/*` do repositório (não no branch da pessoa) para as tarefas seguintes partirem dele.
   * Ausente em workspace sem Git.
   */
  commit?: string;
}

export interface TaskWorkspace {
  root: string;
  kind: WorkspaceKind;
  /** Aviso quando algum commit de tarefa anterior não pôde ser usado como base. */
  baseNote?: string;
  /** Resume o que o agente mudou (e guarda o patch em arquivo). */
  finalize(): Promise<FinalizeResult>;
  /** Remove o worktree se não houve mudanças; com mudanças ele fica para revisão. */
  cleanup(): Promise<void>;
}

interface Options {
  workspacePath: string;
  taskId: string;
  attempt: number;
  /** Pasta de dados do Runner (worktrees e patches ficam aqui, fora do repositório). */
  dataDir: string;
  /** Pasta que não é repositório Git: permite escrever direto nela. Padrão: somente leitura. */
  allowDirectWrites?: boolean;
  /** Commits das tarefas anteriores (dependências). A tarefa parte do resultado delas, combinadas. Só SHA-1 hexadecimal completo. */
  baseCommits?: string[];
}

const SHA_RE = /^[0-9a-f]{40}$/;
const IDENT = ['-c', 'user.name=Command AI', '-c', 'user.email=agent@command-ai.local', '-c', 'commit.gpgsign=false'];

const MAX_PATCH_IN_REPORT = 100_000;
const MAX_PATCH_FILE = 5_000_000;

/** Nome seguro para pasta: só letras, números, _ e -. Nenhum separador nem `..` sobrevive. */
const safeName = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'tarefa';

async function runGit(cwd: string, hooksDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    [
      // Sem hooks e sem fsmonitor: o Git não executa programas do repositório ao criar ou inspecionar o worktree.
      '-c', `core.hooksPath=${hooksDir}`,
      '-c', 'core.fsmonitor=false',
      '-c', 'core.autocrlf=false',
      '-c', 'core.quotepath=false',
      ...args,
    ],
    { cwd, timeout: 120_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
  );
  return stdout;
}

/**
 * Prepara a pasta onde o agente trabalha.
 *  - Repositório Git com commit: um worktree isolado (HEAD solto) por tentativa, em `dataDir`. O agente nunca mexe na árvore da pessoa.
 *  - Sem Git: somente leitura (ou escrita direta, se explicitamente permitida).
 */
export async function createTaskWorkspace(opts: Options): Promise<TaskWorkspace> {
  const readOnlyOrDirect = (): TaskWorkspace => ({
    root: opts.workspacePath,
    kind: opts.allowDirectWrites ? 'direct' : 'readonly',
    finalize: async () => ({ changedFiles: 0, stat: '', patch: '', patchFile: null }),
    cleanup: async () => undefined,
  });

  const hooksDir = join(opts.dataDir, 'empty-hooks');
  await mkdir(hooksDir, { recursive: true });

  let toplevel: string;
  try {
    toplevel = (await runGit(opts.workspacePath, hooksDir, ['rev-parse', '--show-toplevel'])).trim();
    await runGit(opts.workspacePath, hooksDir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  } catch {
    return readOnlyOrDirect(); // não é repositório, ou ainda não tem commit
  }

  const name = `${safeName(opts.taskId)}-a${opts.attempt}`;
  const wtPath = join(opts.dataDir, 'worktrees', name);
  await mkdir(join(opts.dataDir, 'worktrees'), { recursive: true });

  // A mesma tentativa reexecutada recomeça limpa.
  try {
    await runGit(toplevel, hooksDir, ['worktree', 'remove', '--force', wtPath]);
  } catch {
    /* não existia */
  }
  await rm(wtPath, { recursive: true, force: true });
  await runGit(toplevel, hooksDir, ['worktree', 'prune']);

  // Bases: só commits completos que ESTE repositório conhece. Qualquer outra coisa nunca chega ao git como argumento.
  const usable: string[] = [];
  const problems: string[] = [];
  for (const sha of opts.baseCommits ?? []) {
    if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
      problems.push('referência de commit inválida');
      continue;
    }
    try {
      await runGit(toplevel, hooksDir, ['cat-file', '-e', `${sha}^{commit}`]);
      if (!usable.includes(sha)) usable.push(sha);
    } catch {
      problems.push(`commit ${sha.slice(0, 8)} não encontrado neste Runner`);
    }
  }
  const baseNote = problems.length ? `${problems.join('; ')}; ${usable.length ? 'usando os demais' : 'partindo do HEAD'}` : undefined;

  await runGit(toplevel, hooksDir, ['worktree', 'add', '--detach', '--quiet', wtPath, usable[0] ?? 'HEAD']);
  for (const sha of usable.slice(1)) {
    try {
      await runGit(wtPath, hooksDir, [...IDENT, 'merge', '--no-edit', '--no-ff', '-m', 'command-ai: combina resultados das tarefas anteriores', sha]);
    } catch {
      await runGit(wtPath, hooksDir, ['merge', '--abort']).catch(() => undefined);
      await runGit(toplevel, hooksDir, ['worktree', 'remove', '--force', wtPath]).catch(() => rm(wtPath, { recursive: true, force: true }));
      await runGit(toplevel, hooksDir, ['worktree', 'prune']).catch(() => undefined);
      throw new Error('Conflito ao combinar os resultados das tarefas anteriores (elas alteram as mesmas linhas); resolva manualmente.');
    }
  }

  // Se o workspace é uma subpasta do repositório, o agente começa na mesma subpasta dentro do worktree.
  const sub = relative(resolve(toplevel), resolve(opts.workspacePath));
  const root = sub && !sub.startsWith('..') ? join(wtPath, sub) : wtPath;

  let last: FinalizeResult | null = null;
  return {
    root,
    kind: 'worktree',
    baseNote,
    async finalize() {
      await runGit(wtPath, hooksDir, ['add', '-A']);
      const names = (await runGit(wtPath, hooksDir, ['diff', '--cached', '--name-only'])).split('\n').filter(Boolean);
      const ref = `refs/command-ai/${name}`;
      if (names.length === 0) {
        const same = (await runGit(wtPath, hooksDir, ['rev-parse', 'HEAD'])).trim();
        await runGit(toplevel, hooksDir, ['update-ref', ref, same]);
        last = { changedFiles: 0, stat: '', patch: '', patchFile: null, commit: same };
        return last;
      }
      const stat = (await runGit(wtPath, hooksDir, ['diff', '--cached', '--stat', '--no-color'])).trim();
      const full = await runGit(wtPath, hooksDir, ['diff', '--cached', '--patch', '--no-color']);
      await mkdir(join(opts.dataDir, 'patches'), { recursive: true });
      const patchFile = join(opts.dataDir, 'patches', `${name}.patch`);
      await writeFile(patchFile, full.length > MAX_PATCH_FILE ? `${full.slice(0, MAX_PATCH_FILE)}\n[patch cortado]\n` : full, 'utf8');
      await runGit(wtPath, hooksDir, [...IDENT, 'commit', '-q', '-m', `command-ai: resultado da tarefa ${opts.taskId} (tentativa ${opts.attempt})`]);
      const commit = (await runGit(wtPath, hooksDir, ['rev-parse', 'HEAD'])).trim();
      await runGit(toplevel, hooksDir, ['update-ref', ref, commit]);
      last = {
        commit,
        changedFiles: names.length,
        stat,
        patch: full.length > MAX_PATCH_IN_REPORT ? `${full.slice(0, MAX_PATCH_IN_REPORT)}\n[patch cortado: veja o arquivo completo]\n` : full,
        patchFile,
      };
      return last;
    },
    async cleanup() {
      const changed = last ? last.changedFiles > 0 : (await readdir(wtPath).catch(() => [])).length > 0 && (await runGit(wtPath, hooksDir, ['status', '--porcelain']).catch(() => 'x')).trim().length > 0;
      if (changed) return; // há trabalho a revisar: o worktree fica
      try {
        await runGit(toplevel, hooksDir, ['worktree', 'remove', '--force', wtPath]);
      } catch {
        await rm(wtPath, { recursive: true, force: true });
        await runGit(toplevel, hooksDir, ['worktree', 'prune']).catch(() => undefined);
      }
    },
  };
}
