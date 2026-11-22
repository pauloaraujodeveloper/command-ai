import { describe, expect, it } from 'vitest';
import { createStore } from '../src/store.ts';
import { Orchestrator, type PlanTask } from '../src/orchestrator.ts';

const SONNET = 'claude-sonnet-5-5';

function setup(budgetUsd = 5) {
  const clock = { t: Date.parse('2026-01-01T00:00:00Z') };
  const store = createStore();
  store.organizations.insert({ id: 'org-a', name: 'Acme' });
  store.agents.insert({ id: 'ag', organizationId: 'org-a', name: 'A', role: 'r', instructions: 'i', providerKind: 'anthropic', model: SONNET, budgetUsd });
  store.projects.insert({ id: 'pr', organizationId: 'org-a', name: 'P', workspacePath: '/w' });
  const orch = new Orchestrator(store, { now: () => clock.t, leaseMs: 60_000, backoffBaseMs: 0 });
  const one: PlanTask[] = [{ id: 'a', title: 'Agente', agentId: 'ag', dependsOn: [], risk: 'low' }];
  const run = (tasks = one, budget = budgetUsd) => {
    const ex = orch.createDraft({ organizationId: 'org-a', projectId: 'pr', agentId: 'ag', goal: 'Meta de teste', budgetUsd: budget, createdBy: 'u', tasks });
    orch.startExecution(ex.id);
    const task = orch.claimTask('org-a', 'r1')!;
    return { ex, task };
  };
  return { clock, store, orch, run };
}

describe('uso por interação com o modelo (addTaskUsage)', () => {
  it('soma tokens e custo, inclusive cache, e publica o uso na hora', () => {
    const { orch, run, store } = setup();
    const { ex, task } = run();
    const out = orch.addTaskUsage(task.id, { model: SONNET, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 100 }, { turn: 1, attempt: 1 });
    expect(out).toEqual({ applied: true, cancel: false });
    const e = store.executions.get(ex.id)!;
    expect([e.inputTokens, e.outputTokens, e.cacheReadTokens, e.cacheWriteTokens]).toEqual([1000, 500, 2000, 100]);
    // US$: 1000*2 + 500*10 + 2000*0,10 + 100*2,5, tudo por milhão
    expect(e.costUsd).toBeCloseTo((1000 * 2 + 500 * 10 + 2000 * 0.1 + 100 * 2.5) / 1e6, 10);
    const ev = store.eventsFor(ex.id).filter((x) => x.type === 'usage.updated');
    expect(ev).toHaveLength(1);
  });

  it('é idempotente por número do turno: repetir o envio não conta em dobro', () => {
    const { orch, run, store } = setup();
    const { ex, task } = run();
    const u = { model: SONNET, inputTokens: 100, outputTokens: 50 };
    expect(orch.addTaskUsage(task.id, u, { turn: 1, attempt: 1 }).applied).toBe(true);
    expect(orch.addTaskUsage(task.id, u, { turn: 1, attempt: 1 }).applied).toBe(false);
    expect(orch.addTaskUsage(task.id, u, { turn: 2, attempt: 1 }).applied).toBe(true);
    expect(orch.addTaskUsage(task.id, u, { turn: 1, attempt: 1 }).applied).toBe(false); // turno antigo
    expect(store.executions.get(ex.id)!.inputTokens).toBe(200);
  });

  it('ignora tentativa antiga e tarefa que já não está rodando', () => {
    const { orch, run, store } = setup();
    const { ex, task } = run();
    const u = { model: SONNET, inputTokens: 100, outputTokens: 50 };
    expect(orch.addTaskUsage(task.id, u, { turn: 1, attempt: 7 })).toEqual({ applied: false, cancel: false });
    orch.completeTask(task.id, { output: 'ok', usage: { model: SONNET, inputTokens: 0, outputTokens: 0 } }, { attempt: 1 });
    expect(orch.addTaskUsage(task.id, u, { turn: 1, attempt: 1 }).applied).toBe(false);
    expect(store.executions.get(ex.id)!.inputTokens).toBe(0);
  });

  it('estourar o orçamento no meio da tarefa encerra a execução e manda o Runner cancelar', () => {
    const { orch, run, store } = setup();
    const { ex, task } = run(undefined, 0.0001);
    const out = orch.addTaskUsage(task.id, { model: SONNET, inputTokens: 1_000_000, outputTokens: 0 }, { turn: 1, attempt: 1 });
    expect(out).toEqual({ applied: true, cancel: true });
    const e = store.executions.get(ex.id)!;
    expect(e.status).toBe('failed');
    expect(e.failureReason).toBe('budget_exceeded');
    expect(store.tasks.get(task.id)!.status).toBe('cancelled');
    expect(orch.heartbeat(task.id, 'r1')).toEqual({ ok: true, cancel: true });
  });

  it('o relatório final com uso zero não duplica o que já foi enviado por turno', () => {
    const { orch, run, store } = setup();
    const { ex, task } = run();
    orch.addTaskUsage(task.id, { model: SONNET, inputTokens: 300, outputTokens: 100 }, { turn: 1, attempt: 1 });
    orch.completeTask(task.id, { output: 'ok', usage: { model: SONNET, inputTokens: 0, outputTokens: 0 } }, { attempt: 1 });
    expect(store.executions.get(ex.id)!.inputTokens).toBe(300);
    expect(store.executions.get(ex.id)!.status).toBe('succeeded');
  });
});

describe('aprovação humana de chamadas de ferramenta', () => {
  const req = { tool: 'run_command', summary: 'npm install', risk: 'high' as const, argsPreview: '{"command":"npm install","network":true}' };

  it('cria um pedido pendente ligado à tarefa, sem mudar o estado dela', () => {
    const { orch, run, store } = setup();
    const { ex, task } = run();
    const a = orch.requestToolApproval(task.id, req, { attempt: 1 });
    expect(a.kind).toBe('tool');
    expect(a.status).toBe('pending');
    expect(a.tool).toEqual({ name: 'run_command', summary: 'npm install', risk: 'high', argsPreview: req.argsPreview });
    expect(store.tasks.get(task.id)!.status).toBe('running'); // o agente segue vivo, esperando
    expect(store.executions.get(ex.id)!.status).toBe('running');
    const ev = store.eventsFor(ex.id).find((e) => e.type === 'approval.requested')!;
    expect(ev.payload).toMatchObject({ approvalId: a.id, kind: 'tool', risk: 'high' });
  });

  it('aprovar libera o agente; rejeitar NÃO falha a tarefa (o agente se adapta)', () => {
    const { orch, run, store } = setup();
    const { ex, task } = run();
    const a1 = orch.requestToolApproval(task.id, req, { attempt: 1 });
    const a2 = orch.requestToolApproval(task.id, { ...req, summary: 'rm -rf build' }, { attempt: 1 });
    orch.decideApproval(a1.id, 'approved', 'u1');
    orch.decideApproval(a2.id, 'rejected', 'u1', 'Muito arriscado');
    expect(orch.toolApprovalStatus(task.id, a1.id)).toEqual({ status: 'approved', reason: null });
    expect(orch.toolApprovalStatus(task.id, a2.id)).toEqual({ status: 'rejected', reason: 'Muito arriscado' });
    expect(store.tasks.get(task.id)!.status).toBe('running');
    expect(store.executions.get(ex.id)!.status).toBe('running'); // rejeitar ferramenta não falha a execução
    expect(store.auditFor('org-a').map((x) => x.action)).toEqual(expect.arrayContaining(['approval.approved', 'approval.rejected']));
  });

  it('não deixa decidir duas vezes nem consultar pedido de outra tarefa', () => {
    const { orch, run } = setup();
    const { task } = run();
    const a = orch.requestToolApproval(task.id, req, { attempt: 1 });
    orch.decideApproval(a.id, 'approved', 'u1');
    expect(() => orch.decideApproval(a.id, 'rejected', 'u1')).toThrow(/já foi decidida/i);
    expect(orch.toolApprovalStatus('outra-tarefa', a.id)).toBeNull();
  });

  it('só uma tarefa em execução, na tentativa certa, pode pedir; e há limite de pedidos pendentes', () => {
    const { orch, run } = setup();
    const { task } = run();
    expect(() => orch.requestToolApproval(task.id, req, { attempt: 9 })).toThrow(/tentativa/i);
    for (let i = 0; i < 5; i++) orch.requestToolApproval(task.id, { ...req, summary: `cmd ${i}` }, { attempt: 1 });
    expect(() => orch.requestToolApproval(task.id, req, { attempt: 1 })).toThrow(/pendentes/i);

    const other = setup();
    const p = other.orch.createDraft({ organizationId: 'org-a', projectId: 'pr', agentId: 'ag', goal: 'Meta de teste', budgetUsd: 5, createdBy: 'u', tasks: [{ id: 'a', title: 'A', agentId: 'ag', dependsOn: [], risk: 'low' }] });
    other.orch.startExecution(p.id); // tarefa na fila, não rodando
    expect(() => other.orch.requestToolApproval(`${p.id}:a`, req)).toThrow(/transi/i);
  });

  it('pedidos pendentes são encerrados quando a tarefa termina, é cancelada ou volta para a fila', () => {
    for (const how of ['complete', 'fail', 'cancel', 'lease'] as const) {
      const { orch, run, store, clock } = setup();
      const { ex, task } = run();
      const a = orch.requestToolApproval(task.id, req, { attempt: 1 });
      if (how === 'complete') orch.completeTask(task.id, { output: 'x', usage: { model: SONNET, inputTokens: 0, outputTokens: 0 } }, { attempt: 1 });
      if (how === 'fail') orch.failTask(task.id, 'x', { attempt: 1 });
      if (how === 'cancel') orch.cancelExecution(ex.id, 'u');
      if (how === 'lease') {
        clock.t += 61_000;
        orch.sweep();
      }
      const after = store.approvals.get(a.id)!;
      expect(after.status, how).toBe('rejected');
      expect(after.reason, how).toBe('tarefa encerrada');
      expect(after.decidedBy, how).toBe('system');
    }
  });
});
