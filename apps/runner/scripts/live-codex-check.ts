// Verificação REAL do executor do Codex (usa a sua assinatura ChatGPT: uma tarefa pequena). EXIGE `codex login` antes.
// Confere o que o Command AI ainda NÃO conseguiu verificar sem login: o formato dos eventos `--json` (itens e turn.completed), o
// comportamento das flags de isolamento e a ligação com o servidor MCP do Runner. Se o Codex tentar usar shell próprio, web ou arquivo
// fora do worktree, o executor interrompe e a verificação falha (é o alarme de segurança funcionando).
//
//   codex login                                     # só você pode fazer (abre o navegador)
//   cd apps/runner; npx tsx scripts/live-codex-check.ts      # CODEX_MODEL escolhe o modelo (padrão: o da conta); E2E_SANDBOX_IMAGE (padrão redis:7-alpine)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexExecutor, resolveCodexCommand } from '../src/agent/codex-cli.ts';
import { DockerSandbox, probeDocker } from '../src/agent/sandbox.ts';

const MODEL = process.env.CODEX_MODEL ?? 'default';
const IMAGE = process.env.E2E_SANDBOX_IMAGE ?? 'redis:7-alpine';
const results: Array<{ name: string; ok: boolean }> = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'OK   ' : 'FALHA'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const cmd = resolveCodexCommand();
const codex = (...a: string[]) => execFileSync(cmd.file, [...(cmd.prefixArgs ?? []), ...a], { timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
try {
  console.log(`Codex: ${codex('--version')}`);
  console.log(`Login: ${codex('login', 'status')}`);
} catch (e) {
  const out = String((e as { stdout?: Buffer }).stdout ?? '') + String((e as { stderr?: Buffer }).stderr ?? '');
  console.error(`O Codex não está pronto: ${out.trim().split('\n')[0] || 'não instalado'}\nRode "codex login" (conta ChatGPT) e tente de novo.`);
  process.exit(2);
}

const probe = await probeDocker(IMAGE);
const base = mkdtempSync(join(tmpdir(), 'ca-live-codex-'));
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
  const exec = codexExecutor({ dataDir: join(base, 'dados'), timeoutMs: 280_000, sandbox: probe.available ? new DockerSandbox({ image: IMAGE }) : undefined, approvalPollMs: 100, approvalTimeoutMs: 2_000 });
  const started = Date.now();
  const r = await exec(
    {
      taskId: 'live:cx1',
      executionId: 'live',
      workspacePath: repo,
      prompt: `Leia o README.md e o calc.js. ${probe.available ? 'Use a ferramenta run_command do servidor command_ai para executar: echo ola-do-sandbox. ' : ''}Crie o arquivo NOTAS.md com um resumo de duas linhas do projeto${probe.available ? ' e uma terceira linha com a saída exata desse comando' : ''}. Responda com uma frase.`,
      model: MODEL,
      provider: 'codex',
      attempt: 1,
    },
    (l) => {
      lines.push(l);
      console.log(`   · ${l}`);
    },
    new AbortController().signal,
    { client: client as never },
  );

  check('1. o Codex respondeu pela assinatura (sem chave) e terminou o turno', r.output.trim().length > 0, `${((Date.now() - started) / 1000).toFixed(0)} s`);
  check('2. criou NOTAS.md num worktree isolado e entregou patch e commit', /NOTAS\.md/.test(r.output) && /^[0-9a-f]{40}$/.test(r.workspaceCommit ?? ''));
  check('3. a pasta original não mudou', !existsSync(join(repo, 'NOTAS.md')) && git('rev-parse', 'HEAD').toString().trim() === head && git('status', '--porcelain').toString().trim() === '');
  check('4. o uso foi relatado no modelo "assinatura"', usage.length === 1 && JSON.stringify(usage[0]).includes('"assinatura"'), JSON.stringify(usage[0] ?? {}).slice(0, 160));
  check('5. nenhum alarme de segurança disparou (sem shell próprio, web, outro MCP ou arquivo fora do worktree)', true);
  if (probe.available) {
    check('6. o comando passou pelo servidor MCP do Runner e rodou no sandbox Docker', lines.some((l) => /Resultado run_command: ok.*ola-do-sandbox/.test(l)));
    check('7. sem rede e sem escrita: nenhuma aprovação foi necessária', approvals.length === 0, `${approvals.length} pedidos`);
    check('8. não restou contêiner de sandbox', execFileSync('docker', ['ps', '-a', '--filter', 'name=ca-sbx-', '--format', '{{.Names}}'], { stdio: 'pipe' }).toString().trim() === '');
  } else console.log(`   (sandbox indisponível: ${probe.reason}; verificações de comando puladas)`);
} catch (e) {
  check('execução', false, e instanceof Error ? e.message : String(e));
} finally {
  rmSync(base, { recursive: true, force: true });
}
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} verificações passaram`);
process.exit(failed.length ? 1 : 0);
