// Teste ponta a ponta da EQUIPE HIERÁRQUICA com processos REAIS: API (memória) + Runner (modelo de demonstração da equipe).
// Orquestrador delega a banco, back-end, front-end e infra; cada um escreve só no próprio escopo; back-end avisa o front-end.
// Não usa chave de API nem rede externa. Uso (de apps/runner):  node scripts/e2e-team.mjs
// Variáveis: E2E_SANDBOX_IMAGE (padrão redis:7-alpine), E2E_PORT (padrão 3097).
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.E2E_PORT ?? '3097';
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
  const def = softwareTeam({ providerKind: 'anthropic', model: 'claude-sonnet-5-5', budgetUsd: 5 });
  const orq = await api('POST', '/agents', def.orchestrator);
  const spec = {};
  for (const s of def.specialists) spec[s.domain] = await api('POST', '/agents', { ...s, parentAgentId: orq.id });
  const agents = (await api('GET', '/agents')).items;
  check('Equipe criada: orquestrador + 4 especialistas ligados a ele', agents.length === 5 && Object.values(spec).every((a) => a.parentAgentId === orq.id), String(agents.length));

  start('runner', 'npx', ['tsx', 'src/cli.ts'], join(root, 'apps/runner'), {
    COMMAND_AI_API_URL: `http://127.0.0.1:${PORT}`,
    COMMAND_AI_RUNNER_TOKEN: runner.token,
    RUNNER_ALLOWED_WORKSPACES: repo,
    RUNNER_EXECUTOR: 'agent-demo',
    RUNNER_DEMO_TEAM: '1',
    RUNNER_SANDBOX_IMAGE: IMAGE,
    RUNNER_DATA_DIR: dataDir,
    RUNNER_POLL_MS: '400',
    RUNNER_APPROVAL_POLL_MS: '400',
    ANTHROPIC_API_KEY: '',
  });
  const rp = procs.at(-1);
  await waitFor(async () => rp.logs.includes('Sandbox de comandos'), 30_000, 'Runner subir');

  const created = await api('POST', '/executions', { goal: 'Criar a tela de pedidos com API, banco e deploy', projectId, agentId: orq.id });
  const exec = created.execution;
  await api('POST', `/executions/${exec.id}/start`, {});
  const decided = new Set();
  const tools = [];
  const end = Date.now() + 120_000;
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
  if (!final) throw new Error('execução da equipe não terminou em 120 s');
  const detail = await api('GET', `/executions/${exec.id}`);
  const tasks = detail.tasks;
  const byPlan = Object.fromEntries(tasks.map((t) => [t.planId, t]));
  const ev = (await api('GET', `/executions/${exec.id}/events?format=json`)).items;

  check('Execução da equipe concluída', final.status === 'succeeded', final.status + (final.failureReason ? ` (${final.failureReason})` : ''));
  check('O orquestrador delegou (aprovação humana de plan_subtasks) e o plano cresceu de 3 para 7 tarefas', tools.filter((n) => n === 'plan_subtasks').length === 1 && tasks.length === 7, `${tasks.length} tarefas; ferramentas: ${tools.join(',')}`);
  check('Cada subtarefa foi para o especialista do domínio certo', byPlan.db?.agentId === spec.database.id && byPlan.api?.agentId === spec.backend.id && byPlan.web?.agentId === spec.frontend.id && byPlan.infra?.agentId === spec.infra.id);
  check('Todas as tarefas terminaram', tasks.every((t) => t.status === 'done'), tasks.map((t) => `${t.planId}:${t.status}`).join(','));

  const idx = (planId, to) => ev.findIndex((e) => e.type === 'task.state_changed' && e.taskId === byPlan[planId]?.id && e.payload?.to === to);
  check('A ordem das dependências foi respeitada (banco → API → tela)', idx('db', 'done') >= 0 && idx('api', 'running') > idx('db', 'done') && idx('web', 'running') > idx('api', 'done'));

  // Escopo de escrita
  const logs = ev.filter((e) => e.type === 'log.appended').map((e) => String(e.payload?.line ?? '')).join('\n');
  check('Escopo: a tentativa do front-end de alterar a API foi recusada com explicação', /fora do escopo de escrita/.test(logs), (logs.match(/Resultado write_file: erro[^\n]*/) ?? [''])[0].slice(0, 120));
  const webTree = git('ls-tree', '-r', '--name-only', byPlan.web.workspaceCommit).toString();
  const apiFile = git('show', `${byPlan.web.workspaceCommit}:apps/api/pedidos.ts`).toString();
  check('Escopo: o arquivo da API continua como o back-end escreveu', /rota = "\/pedidos"/.test(apiFile) && !/alterado pelo front/.test(apiFile));
  check('Escopo: a tela foi criada dentro do escopo do front-end', /apps\/web\/pedidos\.tsx/.test(webTree));
  const orchTasks = ['analise', 'execucao', 'revisao'].map((p) => byPlan[p]);
  check('O orquestrador é somente leitura: nenhuma de suas tarefas escreveu arquivo', !/Escrito:/.test(ev.filter((e) => orchTasks.some((t) => t && t.id === e.taskId)).filter((e) => e.type === 'log.appended').map((e) => e.payload?.line).join('\n')));

  // Conversa entre agentes
  const msgs = (await api('GET', `/executions/${exec.id}/messages`)).items;
  check('Comunicação: a API avisou o front-end do contrato (visível para a pessoa)', msgs.length === 1 && msgs[0].from === 'api' && msgs[0].to === 'web' && /GET \/pedidos/.test(msgs[0].content), JSON.stringify(msgs.map((m) => [m.from, m.to])));
  const webSrc = git('show', `${byPlan.web.workspaceCommit}:apps/web/pedidos.tsx`).toString();
  check('Comunicação: o front-end recebeu o contrato junto com o trabalho e o usou', /GET \/pedidos/.test(webSrc), webSrc.trim().slice(0, 80));
  check('Comunicação: evento message.sent e plan.updated no histórico', ev.some((e) => e.type === 'message.sent') && ev.some((e) => e.type === 'plan.updated'));

  // Resultado final reúne o trabalho de todos
  const finalTree = git('ls-tree', '-r', '--name-only', byPlan.execucao.workspaceCommit).toString();
  check('Resultado: o commit final reúne banco, API, tela e Dockerfile', ['db/migrations/001_pedidos.sql', 'apps/api/pedidos.ts', 'apps/web/pedidos.tsx', 'Dockerfile'].every((f) => finalTree.includes(f)), finalTree.split('\n').filter((l) => !l.startsWith('README')).join(','));
  check('A pasta da pessoa continua intacta', git('rev-parse', 'HEAD').toString().trim() === headBefore && git('status', '--porcelain').toString().trim() === '');

  // O mesmo modelo que desenha a tela, com dados reais
  const h = buildHierarchy({ agents, tasks, messages: msgs, withRequest: true, withResult: true });
  const nodes = Object.fromEntries(h.nodes.filter((n) => n.kind === 'agent').map((n) => [n.id, n]));
  check('Visão hierárquica: 5 agentes, orquestrador acima dos especialistas, todos concluídos', Object.keys(nodes).length === 5 && nodes[orq.id].level === 1 && Object.values(spec).every((a) => nodes[a.id].level === 2 && nodes[a.id].status === 'done'));
  const deps = h.edges.filter((e) => e.kind === 'dependency').map((e) => `${e.from}>${e.to}`).sort();
  check('Visão hierárquica: dependências banco→back-end e back-end→front-end aparecem', deps.includes(`${spec.database.id}>${spec.backend.id}`) && deps.includes(`${spec.backend.id}>${spec.frontend.id}`), deps.length + ' dependências');
  check('Visão hierárquica: mensagem contada para o back-end (enviada) e o front-end (recebida)', nodes[spec.backend.id].sent === 1 && nodes[spec.frontend.id].received === 1);

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
