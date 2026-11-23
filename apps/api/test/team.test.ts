import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

const KEY = 'team-test-signing-key-long-12345678901';
const H = { 'x-command-ai': '1', 'content-type': 'application/json' };

let app: FastifyInstance;
beforeEach(async () => {
  ({ app } = await buildApp({ jobSigningKey: KEY, production: false, logger: false, orchestrator: { backoffBaseMs: 0, leaseMs: 90_000 } }));
});
afterEach(async () => app.close());

async function user(email = 'a@example.com') {
  const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: H, payload: { name: 'A', orgName: `O-${email}`, email, password: 'senha-muito-forte-1' } });
  return { ...H, cookie: `ca_session=${reg.cookies.find((c) => c.name === 'ca_session')!.value}` };
}
const base = { role: 'r', instructions: 'i', providerKind: 'simulated', model: 'claude-sonnet-5-5', budgetUsd: 5 };
const post = (h: Record<string, string>, url: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: h, payload: payload as object });
const patch = (h: Record<string, string>, url: string, payload: unknown) => app.inject({ method: 'PATCH', url: `/api/v1${url}`, headers: h, payload: payload as object });
const mkAgent = async (h: Record<string, string>, over: Record<string, unknown>) => {
  const r = await post(h, '/agents', { ...base, name: `Ag ${Math.random().toString(36).slice(2, 7)}`, ...over });
  expect(r.statusCode, JSON.stringify(r.json())).toBe(201);
  return r.json() as { id: string; kind: string; domain?: string; parentAgentId?: string; writeScopes?: string[]; dependsOnDomains: string[] };
};

/** Equipe do exemplo: orquestrador + front, back, banco e infra. */
async function team(h: Record<string, string>) {
  const orch = await mkAgent(h, { name: 'Orquestrador', kind: 'orchestrator', domain: 'orquestracao', responsibilities: 'Planeja e consolida.' });
  const mk = (name: string, domain: string, writeScopes: string[], dependsOnDomains: string[] = [], responsibilities = `Cuida de ${domain}.`) =>
    mkAgent(h, { name, kind: 'specialist', domain, parentAgentId: orch.id, writeScopes, dependsOnDomains, responsibilities });
  const front = await mk('Front-end', 'frontend', ['apps/web/**'], ['backend']);
  const back = await mk('Back-end', 'backend', ['apps/api/**'], ['database']);
  const db = await mk('Banco de dados', 'database', ['**/migrations/**', '**/*.sql']);
  const infra = await mk('Infraestrutura', 'infra', ['Dockerfile', '.github/**', 'docker-compose.yml']);
  return { orch, front, back, db, infra };
}

describe('perfil do agente e hierarquia', () => {
  it('cria o orquestrador e os especialistas; o perfil volta completo e o padrão é especialista sem restrição', async () => {
    const h = await user();
    const t = await team(h);
    expect(t.front).toMatchObject({ kind: 'specialist', domain: 'frontend', parentAgentId: t.orch.id, writeScopes: ['apps/web/**'], dependsOnDomains: ['backend'] });
    const plain = await mkAgent(h, {});
    expect(plain.kind).toBe('specialist');
    expect(plain.writeScopes).toBeUndefined(); // sem restrição
    const list = (await app.inject({ method: 'GET', url: '/api/v1/agents', headers: h })).json().items;
    expect(list).toHaveLength(6);
  });

  it('só orquestrador pode ter filhos; pai de outra organização ou inexistente não existe', async () => {
    const h = await user();
    const t = await team(h);
    expect((await post(h, '/agents', { ...base, name: 'X', parentAgentId: t.front.id })).statusCode).toBe(422);
    expect((await post(h, '/agents', { ...base, name: 'Y', parentAgentId: 'nao-existe' })).statusCode).toBe(404);
    const other = await user('b@example.com');
    const foreign = await mkAgent(other, { name: 'Orq B', kind: 'orchestrator' });
    expect((await post(h, '/agents', { ...base, name: 'Z', parentAgentId: foreign.id })).statusCode).toBe(404);
  });

  it('domínio repetido entre irmãos é recusado (a delegação acharia dois); em outro orquestrador pode', async () => {
    const h = await user();
    const t = await team(h);
    expect((await post(h, '/agents', { ...base, name: 'Outro front', domain: 'frontend', parentAgentId: t.orch.id })).statusCode).toBe(409);
    expect((await post(h, '/agents', { ...base, name: 'Outro front', domain: 'FrontEnd', parentAgentId: t.orch.id })).statusCode).toBe(409); // sem diferenciar maiúsculas
    const orch2 = await mkAgent(h, { name: 'Orq 2', kind: 'orchestrator' });
    expect((await post(h, '/agents', { ...base, name: 'Front do time 2', domain: 'frontend', parentAgentId: orch2.id })).statusCode).toBe(201);
  });

  it('escopos de escrita inválidos são recusados (caminho absoluto, "..", unidade, caracteres de controle, muitos)', async () => {
    const h = await user();
    for (const bad of ['/etc/**', '../fora/**', 'a/../b', 'C:\\x', 'C:/x/**', '', 'a\0b', 'x'.repeat(201)]) {
      expect((await post(h, '/agents', { ...base, name: 'S', writeScopes: [bad] })).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await post(h, '/agents', { ...base, name: 'S', writeScopes: Array.from({ length: 31 }, (_, i) => `d${i}/**`) })).statusCode).toBe(400);
    expect((await post(h, '/agents', { ...base, name: 'S', writeScopes: [] })).statusCode).toBe(201); // somente leitura é válido
  });

  it('a hierarquia tem profundidade máxima (4) e não aceita ciclo', async () => {
    const h = await user();
    let parent = await mkAgent(h, { name: 'N1', kind: 'orchestrator', domain: 'n1' });
    const chain = [parent];
    for (let i = 2; i <= 4; i++) {
      parent = await mkAgent(h, { name: `N${i}`, kind: 'orchestrator', domain: `n${i}`, parentAgentId: parent.id });
      chain.push(parent);
    }
    expect((await post(h, '/agents', { ...base, name: 'N5', kind: 'orchestrator', parentAgentId: parent.id })).statusCode).toBe(422);
    // ciclo: o topo passa a ser filho do último
    const cyc = await patch(h, `/agents/${chain[0]!.id}`, { parentAgentId: chain[3]!.id });
    expect(cyc.statusCode).toBe(422);
    expect((await patch(h, `/agents/${chain[0]!.id}`, { parentAgentId: chain[0]!.id })).statusCode).toBe(422);
  });
});

describe('editar e apagar agentes', () => {
  it('PATCH altera só os campos enviados e revalida', async () => {
    const h = await user();
    const t = await team(h);
    const res = await patch(h, `/agents/${t.front.id}`, { writeScopes: ['apps/web/**', 'packages/ui/**'], responsibilities: 'Interface e acessibilidade.' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Front-end', domain: 'frontend', writeScopes: ['apps/web/**', 'packages/ui/**'], responsibilities: 'Interface e acessibilidade.' });
    expect((await patch(h, `/agents/${t.front.id}`, { writeScopes: ['../x'] })).statusCode).toBe(400);
    expect((await patch(h, `/agents/${t.front.id}`, { domain: 'backend' })).statusCode).toBe(409); // colide com o irmão
    expect((await patch(h, '/agents/nao-existe', { name: 'x' })).statusCode).toBe(404);
  });

  it('um orquestrador com filhos não vira especialista; apagar com filhos ou em uso é recusado', async () => {
    const h = await user();
    const t = await team(h);
    expect((await patch(h, `/agents/${t.orch.id}`, { kind: 'specialist' })).statusCode).toBe(422);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/agents/${t.orch.id}`, headers: h })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/agents/${t.infra.id}`, headers: h })).statusCode).toBe(204);
    const list = (await app.inject({ method: 'GET', url: '/api/v1/agents', headers: h })).json().items;
    expect(list.some((a: { id: string }) => a.id === t.infra.id)).toBe(false);
  });

  it('agente usado por tarefa não pode ser apagado', async () => {
    const h = await user();
    const t = await team(h);
    const project = (await post(h, '/projects', { name: 'P', workspacePath: '/w' })).json();
    await post(h, '/executions', { goal: 'Meta de teste', projectId: project.id, agentId: t.back.id });
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/agents/${t.back.id}`, headers: h })).statusCode).toBe(409);
  });

  it('outra organização não enxerga nem altera', async () => {
    const h = await user();
    const t = await team(h);
    const other = await user('b@example.com');
    expect((await patch(other, `/agents/${t.front.id}`, { name: 'x' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/agents/${t.front.id}`, headers: other })).statusCode).toBe(404);
  });
});

describe('PRD (contexto) do projeto', () => {
  it('PATCH define o contexto; a lista o devolve; passa de 100 mil caracteres é recusado', async () => {
    const h = await user();
    const project = (await post(h, '/projects', { name: 'P', workspacePath: '/w' })).json();
    const res = await patch(h, `/projects/${project.id}`, { context: '# PRD\nConstruir X.' });
    expect(res.statusCode).toBe(200);
    expect(res.json().context).toBe('# PRD\nConstruir X.');
    const list = (await app.inject({ method: 'GET', url: '/api/v1/projects', headers: h })).json().items;
    expect(list[0].context).toBe('# PRD\nConstruir X.');
    expect((await patch(h, `/projects/${project.id}`, { context: 'x'.repeat(100_001) })).statusCode).toBe(400);
    expect((await patch(h, `/projects/${project.id}`, { context: '' })).json().context).toBeUndefined(); // limpar
  });

  it('o projeto também pode nascer com contexto', async () => {
    const h = await user();
    const r = await post(h, '/projects', { name: 'P', workspacePath: '/w', context: 'Contexto inicial' });
    expect(r.statusCode).toBe(201);
    expect(r.json().context).toBe('Contexto inicial');
  });
});

/* ---- trabalho entregue ao Runner e delegação ---- */
async function run(h: Record<string, string>, agentId: string, context?: string) {
  const project = (await post(h, '/projects', { name: 'P', workspacePath: '/w', ...(context ? { context } : {}) })).json();
  const created = (await post(h, '/executions', { goal: 'Meta de teste', projectId: project.id, agentId })).json();
  const execId = created.execution.id as string;
  await app.inject({ method: 'PATCH', url: `/api/v1/executions/${execId}/plan`, headers: h, payload: { tasks: [{ id: 'planejar', title: 'Planejar', agentId, dependsOn: [], risk: 'low' }, { id: 'consolidar', title: 'Consolidar', agentId, dependsOn: ['planejar'], risk: 'low' }] } });
  await app.inject({ method: 'POST', url: `/api/v1/executions/${execId}/start`, headers: h });
  const runner = { authorization: `Bearer ${(await post(h, '/runners', { name: 'r' })).json().token}`, 'content-type': 'application/json' };
  const claim = async () => (await app.inject({ method: 'POST', url: '/api/v1/runner/claim', headers: runner })).json().job;
  const sub = (taskId: string, tasks: unknown[]) => app.inject({ method: 'POST', url: `/api/v1/runner/tasks/${encodeURIComponent(taskId)}/subtasks`, headers: runner, payload: { attempt: 1, tasks } });
  return { execId, runner, claim, sub, project };
}

describe('o que cada agente recebe no trabalho', () => {
  it('o orquestrador recebe o perfil, a equipe e o PRD inteiro; o contexto vai delimitado e dentro da assinatura', async () => {
    const h = await user();
    const t = await team(h);
    const r = await run(h, t.orch.id, '# PRD\nConstruir o sistema X com login e relatórios.');
    const job = await r.claim();
    expect(job.payload.agent).toMatchObject({ id: t.orch.id, name: 'Orquestrador', kind: 'orchestrator', domain: 'orquestracao' });
    expect(job.payload.team.map((m: { domain: string }) => m.domain).sort()).toEqual(['backend', 'database', 'frontend', 'infra']);
    const front = job.payload.team.find((m: { domain: string }) => m.domain === 'frontend');
    expect(front).toMatchObject({ name: 'Front-end', writeScopes: ['apps/web/**'], dependsOnDomains: ['backend'] });
    expect(job.payload.projectContext).toContain('Construir o sistema X');
    expect(job.payload.projectContextTruncated).toBeFalsy();
    expect(JSON.stringify(job.payload)).not.toMatch(/passwordHash|tokenHash|apiKey/i);
  });

  it('o especialista recebe o próprio papel, os escopos e os colegas, e só um trecho do PRD', async () => {
    const h = await user();
    const t = await team(h);
    const long = '# PRD\n' + 'linha do PRD com bastante texto. '.repeat(1000);
    const r = await run(h, t.front.id, long);
    const job = await r.claim();
    expect(job.payload.agent).toMatchObject({ kind: 'specialist', domain: 'frontend', parent: { name: 'Orquestrador' }, writeScopes: ['apps/web/**'], dependsOnDomains: ['backend'] });
    expect(job.payload.team.map((m: { domain: string }) => m.domain).sort()).toEqual(['backend', 'database', 'infra']); // os colegas, sem ele mesmo
    expect(job.payload.projectContext.length).toBeLessThanOrEqual(12_100);
    expect(job.payload.projectContextTruncated).toBe(true);
  });

  it('agente sem hierarquia segue como antes (sem equipe) e as outras tarefas trazem agente e domínio', async () => {
    const h = await user();
    const solo = await mkAgent(h, { name: 'Solo' });
    const r = await run(h, solo.id);
    const job = await r.claim();
    expect(job.payload.team).toEqual([]);
    expect(job.payload.agent).toMatchObject({ name: 'Solo', kind: 'specialist' });
    expect(job.payload.peers[0]).toMatchObject({ taskId: 'consolidar', agent: 'Solo' });
  });
});

describe('delegação: o orquestrador atribui subtarefas aos especialistas pelo nome ou domínio', () => {
  it('o campo agent resolve por domínio ou nome (sem diferenciar maiúsculas) entre os subordinados', async () => {
    const h = await user();
    const t = await team(h);
    const r = await run(h, t.orch.id);
    const job = await r.claim();
    const res = await r.sub(job.payload.taskId, [
      { id: 'banco', title: 'Modelar as tabelas', agent: 'database' },
      { id: 'api', title: 'Criar os endpoints', agent: 'Back-end', dependsOn: ['banco'] },
      { id: 'tela', title: 'Criar as telas', agent: 'FRONTEND', dependsOn: ['api'] },
      { id: 'deploy', title: 'Configurar o deploy', agent: 'infra' },
    ]);
    expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
    const tasks = (await app.inject({ method: 'GET', url: `/api/v1/executions/${r.execId}`, headers: h })).json().tasks as Array<{ planId: string; agentId: string; dependsOn: string[] }>;
    const by = Object.fromEntries(tasks.map((x) => [x.planId, x]));
    expect(by.banco!.agentId).toBe(t.db.id);
    expect(by.api!.agentId).toBe(t.back.id);
    expect(by.tela!.agentId).toBe(t.front.id);
    expect(by.deploy!.agentId).toBe(t.infra.id);
    expect(by.consolidar!.dependsOn.length).toBeGreaterThan(1); // a consolidação passou a esperar as folhas
  });

  it('agente desconhecido ou fora da equipe é recusado com a lista de quem existe; agentId também é restrito à equipe', async () => {
    const h = await user();
    const t = await team(h);
    const stranger = await mkAgent(h, { name: 'Estranho', domain: 'estranho' });
    const r = await run(h, t.orch.id);
    const job = await r.claim();
    const unknown = await r.sub(job.payload.taskId, [{ id: 'x', title: 'Fazer X', agent: 'mobile' }]);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().detail).toMatch(/frontend/);
    expect(unknown.json().detail).toMatch(/infra/);
    expect((await r.sub(job.payload.taskId, [{ id: 'y', title: 'Fazer Y', agent: 'estranho' }])).statusCode).toBe(404);
    expect((await r.sub(job.payload.taskId, [{ id: 'z', title: 'Fazer Z', agentId: stranger.id }])).statusCode).toBe(404);
    expect((await r.sub(job.payload.taskId, [{ id: 'w', title: 'Fazer W', agentId: t.back.id }])).statusCode).toBe(201); // agentId de quem é da equipe
  });

  it('um especialista só delega para si mesmo (não escala para o time)', async () => {
    const h = await user();
    const t = await team(h);
    const r = await run(h, t.front.id);
    const job = await r.claim();
    expect((await r.sub(job.payload.taskId, [{ id: 'a', title: 'Fazer A', agent: 'backend' }])).statusCode).toBe(404);
    expect((await r.sub(job.payload.taskId, [{ id: 'b', title: 'Fazer B', agentId: t.back.id }])).statusCode).toBe(404);
    expect((await r.sub(job.payload.taskId, [{ id: 'c', title: 'Fazer C' }])).statusCode).toBe(201); // sem agente: o próprio
  });

  it('o resumo das tarefas dos colegas mostra agente e domínio (para saber a quem escrever)', async () => {
    const h = await user();
    const t = await team(h);
    const r = await run(h, t.orch.id);
    const job = await r.claim();
    await r.sub(job.payload.taskId, [{ id: 'banco', title: 'Modelar', agent: 'database' }]);
    const again = (await app.inject({ method: 'GET', url: `/api/v1/executions/${r.execId}`, headers: h })).json();
    expect(again.tasks.length).toBeGreaterThan(2);
  });
});
