import { describe, expect, it } from 'vitest';
import { buildHierarchy, type HAgent, type HTask } from '../src/hierarchy.ts';

const ag = (id: string, over: Partial<HAgent> = {}): HAgent => ({ id, name: id.toUpperCase(), kind: 'specialist', ...over });
const task = (id: string, agentId: string, status = 'pending', dependsOn: string[] = [], planId = id): HTask => ({ id, planId, title: `T ${id}`, agentId, status, dependsOn });

/** Equipe do exemplo: orquestrador + front, back, banco e infra. */
const team = (): HAgent[] => [
  ag('orq', { kind: 'orchestrator', name: 'Orquestrador' }),
  ag('front', { parentAgentId: 'orq', domain: 'frontend' }),
  ag('back', { parentAgentId: 'orq', domain: 'backend' }),
  ag('db', { parentAgentId: 'orq', domain: 'database' }),
  ag('infra', { parentAgentId: 'orq', domain: 'infra' }),
];
const byId = (h: ReturnType<typeof buildHierarchy>) => Object.fromEntries(h.nodes.map((n) => [n.id, n]));

describe('visão da equipe (sem execução)', () => {
  it('pedido no topo, orquestrador, especialistas lado a lado e resultado embaixo; o pai fica centrado nos filhos', () => {
    const h = buildHierarchy({ agents: team(), withRequest: true, withResult: true });
    const n = byId(h);
    expect(n.request!.level).toBe(0);
    expect(n.orq!.level).toBe(1);
    expect([n.front, n.back, n.db, n.infra].map((x) => x!.level)).toEqual([2, 2, 2, 2]);
    expect(n.result!.level).toBe(3);
    const slots = [n.front, n.back, n.db, n.infra].map((x) => x!.slot);
    expect(slots).toEqual([0, 1, 2, 3]); // ordem estável (por nome/ordem da lista), uma coluna cada
    expect(n.orq!.slot).toBeCloseTo(1.5, 5);
    expect(n.request!.slot).toBeCloseTo(1.5, 5);
    expect(n.result!.slot).toBeCloseTo(1.5, 5);
    expect(h.slots).toBe(4);
    expect(h.levels).toBe(4);
  });

  it('arestas: pedido→orquestrador, orquestrador→cada especialista, cada especialista→resultado', () => {
    const h = buildHierarchy({ agents: team(), withRequest: true, withResult: true });
    const tree = h.edges.filter((e) => e.kind === 'tree').map((e) => `${e.from}>${e.to}`).sort();
    expect(tree).toEqual(['orq>back', 'orq>db', 'orq>front', 'orq>infra', 'request>orq']);
    const res = h.edges.filter((e) => e.kind === 'result').map((e) => e.from).sort();
    expect(res).toEqual(['back', 'db', 'front', 'infra']); // só as folhas alimentam o resultado
  });

  it('três níveis como na imagem: orquestrador geral, orquestradores de área e agentes', () => {
    const agents = [
      ag('top', { kind: 'orchestrator' }),
      ag('vendas', { kind: 'orchestrator', parentAgentId: 'top' }),
      ag('fin', { kind: 'orchestrator', parentAgentId: 'top' }),
      ag('pesq', { parentAgentId: 'vendas' }),
      ag('email', { parentAgentId: 'vendas' }),
      ag('dados', { parentAgentId: 'fin' }),
    ];
    const n = byId(buildHierarchy({ agents, withRequest: true, withResult: true }));
    expect(n.top!.level).toBe(1);
    expect(n.vendas!.level).toBe(2);
    expect(n.pesq!.level).toBe(3);
    expect(n.result!.level).toBe(4);
    expect(n.vendas!.slot).toBeCloseTo((n.pesq!.slot + n.email!.slot) / 2, 5);
    expect(n.top!.slot).toBeCloseTo((n.vendas!.slot + n.fin!.slot) / 2, 5);
  });

  it('agente sem hierarquia: pedido → agente → resultado', () => {
    const h = buildHierarchy({ agents: [ag('solo')], withRequest: true, withResult: true });
    expect(h.nodes.map((x) => x.id)).toEqual(['request', 'solo', 'result']);
  });

  it('dados ruins não travam: pai inexistente vira raiz e ciclo vira raízes', () => {
    const h1 = buildHierarchy({ agents: [ag('a', { parentAgentId: 'apagado' })], withRequest: true, withResult: false });
    expect(byId(h1).a!.level).toBe(1);
    const h2 = buildHierarchy({ agents: [ag('x', { parentAgentId: 'y' }), ag('y', { parentAgentId: 'x' })], withRequest: true, withResult: false });
    expect(h2.nodes.filter((n) => n.kind === 'agent')).toHaveLength(2);
    expect(h2.nodes.every((n) => Number.isFinite(n.slot) && Number.isFinite(n.level))).toBe(true);
  });
});

describe('visão da execução', () => {
  const tasks: HTask[] = [
    task('planejar', 'orq', 'done'),
    task('banco', 'db', 'done', ['planejar']),
    task('api', 'back', 'running', ['banco']),
    task('tela', 'front', 'pending', ['api']),
    task('consolidar', 'orq', 'pending', ['tela']),
  ];

  it('mostra só os agentes que participam (e os pais deles), com as tarefas de cada um', () => {
    const h = buildHierarchy({ agents: team(), tasks, withRequest: true, withResult: true });
    const n = byId(h);
    expect(n.infra).toBeUndefined(); // não participou
    expect(n.orq!.tasks?.map((t) => t.id)).toEqual(['planejar', 'consolidar']);
    expect(n.back!.tasks?.map((t) => t.id)).toEqual(['api']);
    expect(n.front!.level).toBe(2);
  });

  it('estado do agente a partir das tarefas: em execução, concluído, aguardando aprovação, falhou', () => {
    const h = buildHierarchy({ agents: team(), tasks, withRequest: true, withResult: true });
    const n = byId(h);
    expect(n.back!.status).toBe('running');
    expect(n.db!.status).toBe('done');
    expect(n.front!.status).toBe('pending');
    const f = byId(buildHierarchy({ agents: team(), tasks: [task('a', 'front', 'failed'), task('b', 'front', 'done')], withRequest: true, withResult: true }));
    expect(f.front!.status).toBe('failed');
    const w = byId(buildHierarchy({ agents: team(), tasks: [task('a', 'front', 'waiting_approval'), task('b', 'front', 'running')], withRequest: true, withResult: true }));
    expect(w.front!.status).toBe('waiting_approval');
  });

  it('dependências entre agentes diferentes viram arestas sem repetição; entre pai e filho não', () => {
    const h = buildHierarchy({ agents: team(), tasks, withRequest: true, withResult: true });
    const deps = h.edges.filter((e) => e.kind === 'dependency').map((e) => `${e.from}>${e.to}`).sort();
    expect(deps).toEqual(['back>front', 'db>back']); // banco→API→tela; planejar→banco e tela→consolidar são pai/filho
    const dup = buildHierarchy({ agents: team(), tasks: [...tasks, task('api2', 'back', 'pending', ['banco'])], withRequest: true, withResult: true });
    expect(dup.edges.filter((e) => e.kind === 'dependency' && e.from === 'db' && e.to === 'back')).toHaveLength(1);
  });

  it('conta as mensagens enviadas e recebidas por agente (pelos ids de tarefa do plano)', () => {
    const msgs = [{ from: 'api', to: 'tela' }, { from: 'api', to: 'tela' }, { from: 'tela', to: 'api' }, { from: 'planejar', to: 'api' }];
    const n = byId(buildHierarchy({ agents: team(), tasks, messages: msgs, withRequest: true, withResult: true }));
    expect(n.back!.sent).toBe(2);
    expect(n.back!.received).toBe(2); // da tela e do planejar
    expect(n.front!.sent).toBe(1);
    expect(n.front!.received).toBe(2);
    expect(n.orq!.sent).toBe(1);
  });

  it('mensagem com tarefa desconhecida é ignorada', () => {
    const n = byId(buildHierarchy({ agents: team(), tasks, messages: [{ from: 'fantasma', to: 'api' }], withRequest: true, withResult: true }));
    expect(n.back!.received).toBe(0);
  });

  it('execução com um agente só e sem hierarquia: pedido → agente → resultado', () => {
    const h = buildHierarchy({ agents: [ag('solo')], tasks: [task('a', 'solo', 'done'), task('b', 'solo', 'done', ['a'])], withRequest: true, withResult: true });
    expect(h.nodes.map((n) => n.id)).toEqual(['request', 'solo', 'result']);
    expect(h.edges.filter((e) => e.kind === 'dependency')).toEqual([]); // dependências do mesmo agente não aparecem
  });

  it('tarefa de agente apagado (desconhecido) não quebra: vira um nó "agente removido"', () => {
    const h = buildHierarchy({ agents: team(), tasks: [task('x', 'sumiu', 'done')], withRequest: true, withResult: true });
    expect(h.nodes.some((n) => n.kind === 'agent' && n.removed)).toBe(true);
  });
});
