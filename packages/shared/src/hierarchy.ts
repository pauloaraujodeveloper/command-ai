/*
 * Visão hierárquica dos agentes (como no diagrama de orquestração): pedido → orquestrador → especialistas → resultado.
 * Só calcula o modelo (níveis, colunas, arestas, estado, mensagens); quem desenha é a interface. Tolera dados ruins (pai apagado, ciclo).
 */

export interface HAgent {
  id: string;
  name: string;
  kind?: 'orchestrator' | 'specialist';
  domain?: string;
  parentAgentId?: string;
  responsibilities?: string;
  writeScopes?: string[];
  dependsOnDomains?: string[];
}

export interface HTask {
  id: string;
  planId: string;
  title: string;
  agentId: string;
  dependsOn: string[];
  status: string;
}

/** Mensagem entre agentes, pelos ids de tarefa do plano (`planId`). */
export interface HMessage {
  from: string;
  to: string;
}

export interface HNode {
  id: string;
  kind: 'request' | 'agent' | 'result';
  level: number;
  /** Coluna (pode ser fracionária: o pai fica centrado sobre os filhos). */
  slot: number;
  agent?: HAgent;
  /** Agente que não existe mais (apagado), mas ainda tem tarefas. */
  removed?: boolean;
  tasks?: HTask[];
  /** Estado do agente a partir das tarefas. Ausente quando não há tarefas (visão da equipe). */
  status?: string;
  sent: number;
  received: number;
}

export interface HEdge {
  from: string;
  to: string;
  /** tree: delegação; dependency: um agente espera o trabalho de outro; result: alimenta o resultado final. */
  kind: 'tree' | 'dependency' | 'result';
}

export interface Hierarchy {
  nodes: HNode[];
  edges: HEdge[];
  levels: number;
  slots: number;
}

function agentStatus(tasks: HTask[]): string | undefined {
  if (tasks.length === 0) return undefined;
  const has = (s: string) => tasks.some((t) => t.status === s);
  if (has('failed')) return 'failed';
  if (has('waiting_approval')) return 'waiting_approval';
  if (has('running') || has('queued')) return 'running';
  if (tasks.every((t) => t.status === 'done')) return 'done';
  if (tasks.every((t) => t.status === 'cancelled')) return 'cancelled';
  if (has('done')) return 'running'; // parte pronta, parte esperando: está em andamento
  return 'pending';
}

export function buildHierarchy(o: { agents: HAgent[]; tasks?: HTask[]; messages?: HMessage[]; withRequest?: boolean; withResult?: boolean }): Hierarchy {
  const all = new Map(o.agents.map((a) => [a.id, a]));
  const tasks = o.tasks;

  // Quais agentes aparecem: na visão da equipe todos; na da execução os que têm tarefa e os pais deles.
  const shown = new Map<string, HAgent>();
  const removed = new Set<string>();
  if (!tasks) for (const a of o.agents) shown.set(a.id, a);
  else {
    const want = new Set(tasks.map((t) => t.agentId));
    const addWithAncestors = (id: string) => {
      const seen = new Set<string>();
      let cur: string | undefined = id;
      while (cur && !seen.has(cur) && !shown.has(cur)) {
        seen.add(cur);
        const a = all.get(cur);
        if (!a) {
          shown.set(cur, { id: cur, name: 'Agente removido' });
          removed.add(cur);
          break;
        }
        shown.set(cur, a);
        cur = a.parentAgentId;
      }
    };
    // ordem estável: a da lista de agentes, depois os desconhecidos
    for (const a of o.agents) if (want.has(a.id)) addWithAncestors(a.id);
    for (const id of want) addWithAncestors(id);
    // mantém a ordem original da lista
    const ordered = new Map<string, HAgent>();
    for (const a of o.agents) if (shown.has(a.id)) ordered.set(a.id, shown.get(a.id)!);
    for (const [id, a] of shown) if (!ordered.has(id)) ordered.set(id, a);
    shown.clear();
    for (const [id, a] of ordered) shown.set(id, a);
  }

  // Pai efetivo: existe entre os exibidos e não forma ciclo.
  const parent = new Map<string, string | undefined>();
  for (const a of shown.values()) {
    const p = a.parentAgentId && shown.has(a.parentAgentId) ? a.parentAgentId : undefined;
    let cyc = false;
    const seen = new Set<string>([a.id]);
    let cur = p;
    while (cur) {
      if (seen.has(cur)) {
        cyc = true;
        break;
      }
      seen.add(cur);
      cur = shown.get(cur)?.parentAgentId && shown.has(shown.get(cur)!.parentAgentId!) ? shown.get(cur)!.parentAgentId : undefined;
    }
    parent.set(a.id, cyc ? undefined : p);
  }
  const children = new Map<string, string[]>();
  for (const a of shown.values()) {
    const p = parent.get(a.id);
    if (p) children.set(p, [...(children.get(p) ?? []), a.id]);
  }
  const roots = [...shown.keys()].filter((id) => !parent.get(id));
  const isAncestor = (anc: string, id: string) => {
    let cur = parent.get(id);
    for (let i = 0; cur && i < 10; i++) {
      if (cur === anc) return true;
      cur = parent.get(cur);
    }
    return false;
  };

  // Layout: folhas em colunas consecutivas; o pai centrado entre o primeiro e o último filho.
  const base = o.withRequest ? 1 : 0;
  const level = new Map<string, number>();
  const slot = new Map<string, number>();
  const order: string[] = [];
  let next = 0;
  const place = (id: string, depth: number) => {
    order.push(id);
    level.set(id, base + depth);
    const kids = children.get(id) ?? [];
    if (kids.length === 0) {
      slot.set(id, next++);
      return;
    }
    for (const k of kids) place(k, depth + 1);
    slot.set(id, (slot.get(kids[0]!)! + slot.get(kids[kids.length - 1]!)!) / 2);
  };
  for (const r of roots) place(r, 0);

  const slots = Math.max(1, next);
  const center = (slots - 1) / 2;
  const maxLevel = Math.max(0, ...[...level.values()]);

  // Mensagens por agente (pelo id da tarefa no plano).
  const agentOfPlan = new Map((tasks ?? []).map((t) => [t.planId, t.agentId]));
  const sent = new Map<string, number>();
  const received = new Map<string, number>();
  for (const m of o.messages ?? []) {
    const a = agentOfPlan.get(m.from);
    const b = agentOfPlan.get(m.to);
    if (!a || !b) continue;
    sent.set(a, (sent.get(a) ?? 0) + 1);
    received.set(b, (received.get(b) ?? 0) + 1);
  }

  const nodes: HNode[] = [];
  if (o.withRequest) nodes.push({ id: 'request', kind: 'request', level: 0, slot: roots.length ? (slot.get(roots[0]!)! + slot.get(roots[roots.length - 1]!)!) / 2 : center, sent: 0, received: 0 });
  for (const id of order) {
    const mine = (tasks ?? []).filter((t) => t.agentId === id);
    nodes.push({
      id,
      kind: 'agent',
      level: level.get(id)!,
      slot: slot.get(id)!,
      agent: shown.get(id)!,
      ...(removed.has(id) ? { removed: true } : {}),
      ...(tasks ? { tasks: mine, status: agentStatus(mine) } : {}),
      sent: sent.get(id) ?? 0,
      received: received.get(id) ?? 0,
    });
  }
  if (o.withResult) nodes.push({ id: 'result', kind: 'result', level: maxLevel + 1, slot: center, sent: 0, received: 0 });

  const edges: HEdge[] = [];
  if (o.withRequest) for (const r of roots) edges.push({ from: 'request', to: r, kind: 'tree' });
  for (const [p, kids] of children) for (const k of kids) edges.push({ from: p, to: k, kind: 'tree' });

  if (tasks) {
    const byTask = new Map(tasks.map((t) => [t.id, t]));
    const seen = new Set<string>();
    for (const t of tasks) {
      for (const d of t.dependsOn) {
        const dep = byTask.get(d);
        if (!dep || dep.agentId === t.agentId) continue;
        if (isAncestor(dep.agentId, t.agentId) || isAncestor(t.agentId, dep.agentId)) continue; // delegação e devolução já são a árvore
        const key = `${dep.agentId}>${t.agentId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from: dep.agentId, to: t.agentId, kind: 'dependency' });
      }
    }
  }
  if (o.withResult) for (const id of order) if (!(children.get(id)?.length)) edges.push({ from: id, to: 'result', kind: 'result' });

  return { nodes, edges, levels: maxLevel + 1 + (o.withResult ? 1 : 0), slots };
}
