// Sobe API (servindo o painel) + Runner de demonstração e deixa uma aprovação de FERRAMENTA pendente para você ver na tela.
// Uso (de apps/runner):  node scripts/demo-pending-approval.mjs   (Ctrl+C encerra tudo e limpa os arquivos temporários)
// Entra em http://127.0.0.1:3097 com o usuário de teste impresso abaixo. Nada sai da sua máquina; sem chave de API.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.DEMO_PORT ?? '3097';
const IMAGE = process.env.E2E_SANDBOX_IMAGE ?? 'redis:7-alpine';
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const root = resolve(import.meta.dirname, '../../..');
const email = 'demo@example.com';
const password = 'senha-demo-bem-longa-123';

const tmp = mkdtempSync(join(tmpdir(), 'ca-demo-'));
const repo = join(tmp, 'projeto');
mkdirSync(repo);
const git = (...a) => execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@example.com', ...a], { cwd: repo, stdio: 'pipe' });
git('init', '-q', '-b', 'main');
writeFileSync(join(repo, 'README.md'), '# Projeto de demonstração\n');
git('add', '-A');
git('commit', '-q', '-m', 'init');

const procs = [];
const start = (cmd, args, cwd, env) => {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true, shell: process.platform === 'win32' });
  procs.push(p);
  return p;
};
const stopAll = () => {
  for (const p of procs) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(p.pid), '/t', '/f'], { stdio: 'ignore' });
      else p.kill('SIGKILL');
    } catch {
      /* já encerrado */
    }
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignora */
  }
};
process.on('SIGINT', () => {
  stopAll();
  process.exit(0);
});

let cookie = '';
async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', 'x-command-ai': '1', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : undefined;
}

start('npx', ['tsx', 'src/server.ts'], join(root, 'apps/api'), { PORT, HOST: '127.0.0.1', COMMAND_AI_STORAGE: 'memory', REQUIRE_MFA: 'false', NODE_ENV: 'development' });
for (let i = 0; i < 80; i++) {
  if (await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false)) break;
  await sleep(500);
}
await api('POST', '/auth/register', { name: 'Demo', orgName: 'Demo Org', email, password });
const runner = await api('POST', '/runners', { name: 'runner-demo' });
const project = await api('POST', '/projects', { name: 'Projeto de demonstração', workspacePath: repo });
const agent = await api('POST', '/agents', { name: 'Documentador', role: 'Documenta projetos', instructions: 'Documente o projeto.', providerKind: 'anthropic', model: 'claude-sonnet-5-5', budgetUsd: 5 });
start('npx', ['tsx', 'src/cli.ts'], join(root, 'apps/runner'), {
  COMMAND_AI_API_URL: `http://127.0.0.1:${PORT}`,
  COMMAND_AI_RUNNER_TOKEN: runner.token,
  RUNNER_ALLOWED_WORKSPACES: repo,
  RUNNER_EXECUTOR: 'agent-demo',
  RUNNER_SANDBOX_IMAGE: IMAGE,
  RUNNER_DATA_DIR: join(tmp, 'runner-data'),
  RUNNER_POLL_MS: '500',
  RUNNER_APPROVAL_POLL_MS: '500',
  RUNNER_APPROVAL_TIMEOUT_MS: '1800000',
  ANTHROPIC_API_KEY: '',
});
const created = await api('POST', '/executions', { goal: 'Documentar o projeto e remover rascunhos', projectId: project.id, agentId: agent.id });
await api('POST', `/executions/${created.execution.id}/start`, {});

// Aprova só as aprovações de TAREFA; as de ferramenta ficam pendentes para você decidir na tela.
(async () => {
  const seen = new Set();
  for (;;) {
    try {
      const { items } = await api('GET', '/approvals');
      for (const a of items.filter((x) => x.status === 'pending' && x.kind !== 'tool' && !seen.has(x.id))) {
        seen.add(a.id);
        await api('POST', `/approvals/${a.id}/decide`, { decision: 'approved' });
      }
    } catch {
      /* continua */
    }
    await sleep(500);
  }
})();

console.log(`\nPronto: http://127.0.0.1:${PORT}\nEntrar com ${email} / ${password}\nExecução: ${created.execution.id}\nCtrl+C para encerrar.`);
await new Promise(() => undefined);
