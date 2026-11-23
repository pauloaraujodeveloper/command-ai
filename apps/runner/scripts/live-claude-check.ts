// Verificação com o Claude Code REAL (usa a sua assinatura: uma tarefa pequena, modelo mais barato por padrão).
// Roda num repositório temporário, sem Docker e sem a API do Command AI. Nenhuma chave é lida nem enviada.
//
//   cd apps/runner; npx tsx scripts/live-claude-check.ts          # LIVE_CLAUDE_MODEL escolhe o modelo (padrão haiku)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCodeExecutor } from '../src/agent/claude-code.ts';

const MODEL = process.env.LIVE_CLAUDE_MODEL ?? 'haiku';
const results: Array<{ name: string; ok: boolean }> = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'OK   ' : 'FALHA'} ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  const v = execFileSync(process.env.RUNNER_CLAUDE_BIN || 'claude', ['--version'], { timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  console.log(`Claude Code: ${v}`);
} catch {
  console.error('O CLI do Claude Code não foi encontrado. Instale-o, faça login, ou defina RUNNER_CLAUDE_BIN.');
  process.exit(2);
}

const base = mkdtempSync(join(tmpdir(), 'ca-live-claude-'));
try {
  const repo = join(base, 'repo');
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=live', '-c', 'user.email=live@example.com', ...a], { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# Calculadora\nBiblioteca pequena com soma e subtração.\n');
  writeFileSync(join(repo, 'calc.js'), 'export const soma = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const head = git('rev-parse', 'HEAD').toString().trim();

  const usageCalls: unknown[] = [];
  const lines: string[] = [];
  const exec = claudeCodeExecutor({ dataDir: join(base, 'dados'), timeoutMs: 240_000 });
  const started = Date.now();
  const r = await exec(
    { taskId: 'live:t1', executionId: 'live', workspacePath: repo, prompt: 'Leia o README.md e o calc.js e crie o arquivo NOTAS.md com um resumo de duas linhas do projeto. Responda com uma frase.', model: MODEL, provider: 'claude_code', attempt: 1 },
    (l) => {
      lines.push(l);
      console.log(`   · ${l}`);
    },
    new AbortController().signal,
    { client: { usage: async (_t: string, b: unknown) => (usageCalls.push(b), { applied: true, cancel: false }) } as never },
  );

  check('1. o Claude Code respondeu pela assinatura (sem chave) e terminou com resultado', r.output.trim().length > 0, `${((Date.now() - started) / 1000).toFixed(0)} s`);
  check('2. criou NOTAS.md num worktree isolado e entregou patch e commit', /NOTAS\.md/.test(r.output) && /^[0-9a-f]{40}$/.test(r.workspaceCommit ?? ''));
  check('3. a pasta original não mudou (sem arquivo novo, mesmo commit, árvore limpa)', !existsSync(join(repo, 'NOTAS.md')) && git('rev-parse', 'HEAD').toString().trim() === head && git('status', '--porcelain').toString().trim() === '');
  check('4. o uso foi relatado (tokens e cache) no modelo "assinatura"', usageCalls.length === 1 && JSON.stringify(usageCalls[0]).includes('"assinatura"'), JSON.stringify(usageCalls[0] ?? {}).slice(0, 160));
  check('5. as ferramentas rodaram dentro do limite (só arquivos)', lines.some((l) => /Ferramenta (Read|Write|Glob|Grep)/.test(l)) && !lines.some((l) => /Ferramenta (Bash|PowerShell|WebFetch)/.test(l)));
  if (r.workspaceCommit) console.log(`   · NOTAS.md: ${git('show', `${r.workspaceCommit}:NOTAS.md`).toString().trim().slice(0, 200).replace(/\n/g, ' ⏎ ')}`);
  void readFileSync;
} catch (e) {
  check('execução', false, e instanceof Error ? e.message : String(e));
} finally {
  rmSync(base, { recursive: true, force: true });
}
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} verificações passaram`);
process.exit(failed.length ? 1 : 0);
