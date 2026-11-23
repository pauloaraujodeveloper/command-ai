// Teste REAL da equipe hierárquica: API (memória) + Runner com o Claude Code (sua assinatura, modelo haiku) em TODOS os agentes.
// Gasta uso do plano (várias tarefas pequenas) e leva alguns minutos. Não é determinístico: relata o que o modelo fez, sem exigir que delegue.
// Uso (de apps/runner):  node scripts/live-team-e2e.mjs      # LIVE_CLAUDE_MODEL (padrão haiku), E2E_SANDBOX_IMAGE, E2E_PORT (padrão 3096)
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.E2E_PORT ?? '3096';
const IMAGE = process.env.E2E_SANDBOX_IMAGE ?? 'redis:7-alpine';
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const root = resolve(import.meta.dirname, '../../..');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'OK  ' : 'FALHA'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const tmp = mkdtempSync(join(tmpdir(), 'ca-team-'));
const repo = join(tmp, 'projeto');
const dataDir = join(tmp, 'runner-data');
mkdirSync(repo);
const git = (...a) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...a], { cwd: repo, stdio: 'pipe' });
git('init', '-q', '-b', 'main');
writeFileSync(join(repo, 'README.md'), '# Projeto da equipe\n');
git('add', '-A');
git('commit', '-q', '-m', 'init');
const headBefore = git('rev-parse', 'HEAD').toString().trim();

const procs = [];
function start(name, cmd, args, cwd, env) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const rec = { name, p, logs: '' };
  p.stdout.on('data', (d) => (rec.logs += d));
  p.stderr.on('data', (d) => (rec.logs += d));
  procs.push(rec);
}
function stopAll() {
  for (const { p } of procs) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
      else p.kill('SIGTERM');
    } catch {
      /* já encerrado */
    }
  }
}

let cookie = '';
async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-command-ai': '1', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return json;
}
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`tempo esgotado: ${what}`);
    await sleep(400);
  }
}

try {
  const { softwareTeam } = await import('../../../packages/shared/src/team.ts');
  const { buildHierarchy } = await import('../../../packages/shared/src/hierarchy.ts');

  start('api', 'npx', ['tsx', 'src/server.ts'], join(root, 'apps/api'), { PORT, HOST: '127.0.0.1', COMMAND_AI_STORAGE: 'memory', REQUIRE_MFA: 'false', NODE_ENV: 'development' });
  await waitFor(async () => fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false), 40_000, 'API subir');
  await api('POST', '/auth/register', { name: 'E2E', orgName: 'Equipe Org', email: `team-${Date.now()}@example.com`, password: 'senha-e2e-bem-longa-123' });
  const runner = await api('POST', '/runners', { name: 'runner-team' });
  const projectId = (await api('POST', '/projects', { name: 'Projeto Equipe', workspacePath: repo, context: '# PRD\nSistema de pedidos: banco, API, tela e Dockerfile.' })).id;

  // Equipe pelo mesmo modelo que a tela "Criar time de software" usa.
  const def = softwareTeam({ providerKind: 'claude_code', model: process.env.LIVE_CLAUDE_MODEL ?? 'haiku', budgetUsd: 5 });
  const orq = await api('POST', '/agents', def.orchestrator);
  const spec = {};
  for (const s of def.specialists) spec[s.domain] = await api('POST', '/agents', { ...s, parentAgentId: orq.id });
  const agents = (await api('GET', '/agents')).items;
  check('Equipe criada: orquestrador + 4 especialistas ligados a ele', agents.length === 5 && Object.values(spec).every((a) => a.parentAgentId === orq.id), String(agents.length));

  start('runner', 'npx', ['tsx', 'src/cli.ts'], join(root, 'apps/runner'), {
    COMMAND_AI_API_URL: `http://127.0.0.1:${PORT}`,
    COMMAND_AI_RUNNER_TOKEN: runner.token,
    RUNNER_ALLOWED_WORKSPACES: repo,
    RUNNER_EXECUTOR: 'agent',
    RUNNER_SANDBOX_IMAGE: IMAGE,
    RUNNER_DATA_DIR: dataDir,
    RUNNER_POLL_MS: '400',
    RUNNER_APPROVAL_POLL_MS: '400',
    ANTHROPIC_API_KEY: '',
  });
  const rp = procs.at(-1);
  await waitFor(async () => rp.logs.includes('Sandbox de comandos'), 30_000, 'Runner subir');

  const created = await api('POST', '/executions', { goal: 'Em equipe, crie um sistema mínimo de lista de tarefas: uma migração SQL (tabela tarefas), uma rota de API em apps/api/tarefas.ts, uma tela em apps/web/tarefas.tsx que usa essa rota, e um Dockerfile. Como orquestrador, DELEGUE cada parte ao especialista da área com plan_subtasks (campo agent: database, backend, frontend, infra), declarando dependências (API depende do banco; tela depende da API). Os especialistas devem combinar o contrato da API por send_message. Arquivos pequenos, de poucas linhas.', projectId, agentId: orq.id });
  const exec = created.execution;
  await api('POST', `/executions/${exec.id}/start`, {});
  const decided = new Set();
  const tools = [];
  const end = Date.now() + 900_000;
  let final;
  while (Date.now() < end) {
    const { items } = await api('GET', '/approvals');
    for (const a of items.filter((x) => x.status === 'pending' && x.executionId === exec.id)) {
      if (decided.has(a.id)) continue;
      decided.add(a.id);
      if (a.kind === 'tool') tools.push(a.tool?.name);
      await api('POST', `/approvals/${a.id}/decide`, { decision: 'approved' });
    }
    const cur = (await api('GET', `/executions/${exec.id}`)).execution;
    if (['succeeded', 'failed', 'cancelled'].includes(cur.status)) {
      final = cur;
      break;
    }
    await sleep(400);
  }
  if (!final) throw new Error('execução da equipe não terminou em 15 min');
  const detail = await api('GET', `/executions/${exec.id}`);
  const tasks = detail.tasks;
  const byPlan = Object.fromEntries(tasks.map((t) => [t.planId, t]));
  const ev = (await api('GET', `/executions/${exec.id}/events?format=json`)).items;

  check('Execução da equipe terminou', final.status === 'succeeded', final.status + (final.failureReason ? ` (${final.failureReason})` : ''));
  const msgs = (await api('GET', `/executions/${exec.id}/messages`)).items;
  const subs = tasks.filter((t) => t.parentTaskId);
  const nameOf = (id) => agents.find((x) => x.id === id)?.name ?? id;
  console.log('\n--- O que a equipe fez ---');
  console.log(`Ferramentas aprovadas: ${tools.join(', ') || '(nenhuma)'}`);
  for (const t of tasks) console.log(`  [${t.status}] ${t.planId} — ${nameOf(t.agentId)} — ${t.title.slice(0, 70)}`);
  console.log(`Mensagens entre agentes: ${msgs.length}`);
  for (const m of msgs) console.log(`  ${m.from} -> ${m.to}: ${m.content.slice(0, 100)}`);
  const refused = ev.filter((e) => e.type === 'log.appended' && /fora do escopo|somente leitura/.test(String(e.payload?.line ?? ''))).length;
  console.log(`Recusas de escopo vistas no log: ${refused}`);
  for (const t of tasks) if (t.workspaceCommit) console.log(`  árvore de ${t.planId}: ${git('ls-tree', '-r', '--name-only', t.workspaceCommit).toString().split('\n').filter((l) => l && l !== 'README.md').join(', ') || '(vazia)'}`);
  const lastCommit = tasks.find((t) => t.planId === 'execucao')?.workspaceCommit;
  const finalTree = lastCommit ? git('ls-tree', '-r', '--name-only', lastCommit).toString().split('\n').filter((l) => l && l !== 'README.md') : [];
  console.log(`Arquivos no resultado final: ${finalTree.join(', ') || '(nenhum)'}`);
  check('O orquestrador delegou (criou subtarefas)', subs.length > 0, `${subs.length} subtarefas`);
  check('As subtarefas foram para especialistas diferentes do orquestrador', subs.some((t) => t.agentId !== orq.id), [...new Set(subs.map((t) => nameOf(t.agentId)))].join(', '));
  check('Os arquivos foram criados nas áreas certas', finalTree.some((f) => f.startsWith('apps/api/')) && finalTree.some((f) => f.startsWith('apps/web/')), finalTree.join(','));
  check('A pasta da pessoa continua intacta', git('rev-parse', 'HEAD').toString().trim() === headBefore && git('status', '--porcelain').toString().trim() === '');
  const h = buildHierarchy({ agents, tasks, messages: msgs, withRequest: true, withResult: true });
  console.log(`Hierarquia: ${h.nodes.filter((n) => n.kind === 'agent').length} agentes, ${h.edges.filter((e) => e.kind === 'dependency').length} dependências entre agentes`);

  const leftovers = execFileSync('docker', ['ps', '-a', '--filter', 'name=ca-sbx-', '--format', '{{.Names}}'], { stdio: 'pipe' }).toString().trim();
  check('Nenhum contêiner de sandbox sobrando', leftovers === '', leftovers);
  check('Runner sem erros de comunicação', !/Erro de comunica/.test(rp.logs));
} catch (err) {
  check(`erro inesperado: ${err instanceof Error ? err.message : err}`, false);
  for (const p of procs) console.log(`--- log ${p.name} (fim) ---\n${p.logs.slice(-1800)}`);
} finally {
  stopAll();
  await sleep(500);
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignora */
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} verificações passaram`);
process.exit(failed.length ? 1 : 0);
