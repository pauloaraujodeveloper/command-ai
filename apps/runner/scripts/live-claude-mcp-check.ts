// Verificação REAL dos comandos do Claude Code pelo servidor MCP do Runner (usa a sua assinatura: uma tarefa pequena; precisa do Docker e de uma imagem local).
// O Claude Code usa a ferramenta run_command (contêiner Docker sem rede) e escreve o resultado num arquivo do worktree.
//
//   cd apps/runner; npx tsx scripts/live-claude-mcp-check.ts      # LIVE_CLAUDE_MODEL (padrão haiku), E2E_SANDBOX_IMAGE (padrão redis:7-alpine)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCodeExecutor } from '../src/agent/claude-code.ts';
import { DockerSandbox, probeDocker } from '../src/agent/sandbox.ts';

const MODEL = process.env.LIVE_CLAUDE_MODEL ?? 'haiku';
const IMAGE = process.env.E2E_SANDBOX_IMAGE ?? 'redis:7-alpine';
const results: Array<{ name: string; ok: boolean }> = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'OK   ' : 'FALHA'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const probe = await probeDocker(IMAGE);
if (!probe.available) {
  console.error(`Sandbox indisponível: ${probe.reason}`);
  process.exit(2);
}

const base = mkdtempSync(join(tmpdir(), 'ca-live-mcp-'));
try {
  const repo = join(base, 'repo');
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=live', '-c', 'user.email=live@example.com', ...a], { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# Projeto\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const head = git('rev-parse', 'HEAD').toString().trim();

  const lines: string[] = [];
  const approvals: unknown[] = [];
  const usage: unknown[] = [];
  const client = {
    usage: async (_t: string, b: unknown) => (usage.push(b), { applied: true, cancel: false }),
    requestApproval: async (_t: string, r: unknown) => (approvals.push(r), { approvalId: 'x' }),
    approvalStatus: async () => ({ status: 'rejected', reason: 'verificação automática' }),
    addSubtasks: async () => ({ added: [] }),
    sendMessage: async () => ({ id: 'm' }),
    readMessages: async () => ({ messages: [] }),
  };
  const exec = claudeCodeExecutor({ dataDir: join(base, 'dados'), timeoutMs: 280_000, sandbox: new DockerSandbox({ image: IMAGE }), approvalPollMs: 100, approvalTimeoutMs: 2_000 });
  const started = Date.now();
  const r = await exec(
    {
      taskId: 'live:t2',
      executionId: 'live',
      workspacePath: repo,
      prompt: 'Use a ferramenta run_command do Runner para executar exatamente: echo ola-do-sandbox. Depois crie o arquivo SAIDA.md contendo exatamente a saída desse comando. Responda com uma frase.',
      model: MODEL,
      provider: 'claude_code',
      attempt: 1,
    },
    (l) => {
      lines.push(l);
      console.log(`   · ${l}`);
    },
    new AbortController().signal,
    { client: client as never },
  );

  check('1. o Claude Code aceitou o servidor MCP do Runner e terminou', r.output.trim().length > 0, `${((Date.now() - started) / 1000).toFixed(0)} s`);
  check('2. usou a ferramenta run_command do Runner (mcp__command_ai__)', lines.some((l) => /Ferramenta mcp__command_ai__run_command/.test(l)) || lines.some((l) => /Ferramenta run_command/.test(l)));
  check('3. o comando rodou no sandbox Docker e a saída voltou', lines.some((l) => /Resultado run_command: ok.*ola-do-sandbox/.test(l)));
  check('4. sem rede e sem escrita: nenhuma aprovação foi necessária', approvals.length === 0, `${approvals.length} pedidos`);
  const saida = r.workspaceCommit ? git('show', `${r.workspaceCommit}:SAIDA.md`).toString() : '';
  check('5. SAIDA.md no worktree contém a saída do comando', /ola-do-sandbox/.test(saida));
  check('6. a pasta original não mudou', !existsSync(join(repo, 'SAIDA.md')) && git('rev-parse', 'HEAD').toString().trim() === head && git('status', '--porcelain').toString().trim() === '');
  check('7. não restou contêiner de sandbox', execFileSync('docker', ['ps', '-a', '--filter', 'name=ca-sbx-', '--format', '{{.Names}}'], { stdio: 'pipe' }).toString().trim() === '');
  check('8. uso relatado', usage.length === 1);
} catch (e) {
  check('execução', false, e instanceof Error ? e.message : String(e));
} finally {
  rmSync(base, { recursive: true, force: true });
}
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} verificações passaram`);
process.exit(failed.length ? 1 : 0);
