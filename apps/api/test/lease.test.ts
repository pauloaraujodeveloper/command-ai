import { describe, expect, it } from 'vitest';
import { createStore } from '../src/store.ts';
import { Orchestrator, type PlanTask } from '../src/orchestrator.ts';

const USAGE = { model: 'claude-sonnet-5-5', inputTokens: 10, outputTokens: 5 };

function setup(opts: { leaseMs?: number; backoffBaseMs?: number; maxExecutionMs?: number } = {}) {
  const clock = { t: Date.parse('2026-01-01T00:00:00Z') };
  const store = createStore();
  store.organizations.insert({ id: 'org-a', name: 'Acme' });
  store.agents.insert({ id: 'ag', organizationId: 'org-a', name: 'A', role: 'r', instructions: 'i', providerKind: 'simulated', model: 'claude-sonnet-5-5', budgetUsd: 5 });
  store.projects.insert({ id: 'pr', organizationId: 'org-a', name: 'P', workspacePath: '/w' });
  const orch = new Orchestrator(store, { now: () => clock.t, leaseMs: 60_000, backoffBaseMs: 1_000, ...opts });
  const draft = (tasks: PlanTask[]) =>
    orch.createDraft({ organizationId: 'org-a', projectId: 'pr', agentId: 'ag', goal: 'Meta de teste', budgetUsd: 5, createdBy: 'u', tasks });
  const one: PlanTask[] = [{ id: 'a', title: 'Único', agentId: 'ag', dependsOn: [], risk: 'low' }];
  return { clock, store, orch, draft, one };
}

describe('lease e heartbeat', () => {
  it('a tarefa reivindicada ganha um lease e o heartbeat o renova', () => {
    const { clock, orch, draft, one, store } = setup();
    const ex = draft(one);
    orch.startExecution(ex.id);
    const t = orch.claimTask('org-a', 'r1')!;
    expect(Date.parse(store.tasks.get(t.id)!.leaseExpiresAt!)).toBe(clock.t + 60_000);

    clock.t += 40_000;
    expect(orch.heartbeat(t.id, 'r1')).toEqual({ ok: true, cancel: false });
    expect(Date.parse(store.tasks.get(t.id)!.leaseExpiresAt!)).toBe(clock.t + 60_000);
  });

  it('heartbeat de outro Runner ou de tarefa que não está rodando não renova nada', () => {
    const { orch, draft, one, store } = setup();
    const ex = draft(one);
    orch.startExecution(ex.id);
    const t = orch.claimTask('org-a', 'r1')!;
    const before = store.tasks.get(t.id)!.leaseExpiresAt;
    expect(orch.heartbeat(t.id, 'intruso')).toEqual({ ok: false, cancel: false });
    expect(store.tasks.get(t.id)!.leaseExpiresAt).toBe(before);
    expect(orch.heartbeat('nao-existe', 'r1')).toEqual({ ok: false, cancel: false });
  });

  it('heartbeat avisa para cancelar quando a execução foi cancelada', () => {
    const { orch, draft, one } = setup();
    const ex = draft(one);
    orch.startExecution(ex.id);
    const t = orch.claimTask('org-a', 'r1')!;
    orch.cancelExecution(ex.id, 'u');
    expect(orch.heartbeat(t.id, 'r1')).toEqual({ ok: true, cancel: true });
  });
});

describe('recuperação de tarefas interrompidas (varredura de leases)', () => {
  it('lease vencido devolve a tarefa à fila com espera, sem perder a contagem de tentativas', () => {
    const { clock, orch, draft, one, store } = setup();
    const ex = draft(one);
    orch.startExecution(ex.id);
    const t = orch.claimTask('org-a', 'r1')!; // o Runner "morre" aqui

    clock.t += 59_000;
    expect(orch.sweep()).toEqual({ requeued: 0, failed: 0, expiredExecutions: 0 });
    clock.t += 2_000; // 61 s: lease vencido
    expect(orch.sweep()).toEqual({ requeued: 1, failed: 0, expiredExecutions: 0 });

    const after = store.tasks.get(t.id)!;
    expect(after.status).toBe('queued');
    expect(after.attempts).toBe(1);
    expect(after.error).toBe('lease_expired');
    expect(after.leaseExpiresAt).toBeUndefined();
    expect(store.eventsFor(ex.id).some((e) => e.type === 'log.appended' && String(e.payload.line).includes('lease'))).toBe(true);
  });

  it('respeita a espera progressiva antes de a tarefa poder ser reivindicada de novo', () => {
    const { clock, orch, draft, one } = setup({ backoffBaseMs: 10_000 });
    const ex = draft(one);
    orch.startExecution(ex.id);
    orch.claimTask('org-a', 'r1');
    clock.t += 61_000;
    orch.sweep();
    expect(orch.claimTask('org-a', 'r2')).toBeNull(); // ainda dentro da espera
    clock.t += 9_000;
    expect(orch.claimTask('org-a', 'r2')).toBeNull();
    clock.t += 1_500;
    expect(orch.claimTask('org-a', 'r2')?.attempts).toBe(2);
  });

  it('a espera dobra a cada tentativa e tem teto', () => {
    const { clock, orch, draft, one, store } = setup({ backoffBaseMs: 1_000 });
    const ex = draft(one);
    orch.startExecution(ex.id);
    const waits: number[] = [];
    for (let i = 0; i < 2; i++) {
      const t = orch.claimTask('org-a', 'r1')!;
      orch.failTask(t.id, 'x');
      waits.push(Date.parse(store.tasks.get(t.id)!.notBefore!) - clock.t);
      clock.t += 120_000;
    }
    expect(waits).toEqual([1_000, 2_000]);
  });

  it('esgotadas as tentativas por lease vencido, a tarefa falha e a execução também', () => {
    const { clock, orch, draft, one, store } = setup({ backoffBaseMs: 0 });
    const ex = draft(one);
    orch.startExecution(ex.id);
    for (let i = 0; i < 3; i++) {
      expect(orch.claimTask('org-a', 'r1')).not.toBeNull();
      clock.t += 61_000;
      orch.sweep();
    }
    const t = store.tasks.filter((x) => x.executionId === ex.id)[0]!;
    expect(t.status).toBe('failed');
    expect(store.executions.get(ex.id)!.status).toBe('failed');
    expect(store.executions.get(ex.id)!.failureReason).toBe('task_failed');
  });

  it('um Runner que continua enviando heartbeat nunca é varrido', () => {
    const { clock, orch, draft, one, store } = setup();
    const ex = draft(one);
    orch.startExecution(ex.id);
    const t = orch.claimTask('org-a', 'r1')!;
    for (let i = 0; i < 10; i++) {
      clock.t += 30_000;
      orch.heartbeat(t.id, 'r1');
      expect(orch.sweep().requeued).toBe(0);
    }
    expect(store.tasks.get(t.id)!.status).toBe('running');
  });

  it('o prazo máximo da execução a encerra, cancelando o que restou', () => {
    const { clock, orch, draft, store } = setup({ maxExecutionMs: 3_600_000 });
    const ex = draft([
      { id: 'a', title: 'A', agentId: 'ag', dependsOn: [], risk: 'low' },
      { id: 'b', title: 'B', agentId: 'ag', dependsOn: ['a'], risk: 'low' },
    ]);
    orch.startExecution(ex.id);
    const t = orch.claimTask('org-a', 'r1')!;
    clock.t += 3_500_000;
    orch.heartbeat(t.id, 'r1');
    expect(orch.sweep().expiredExecutions).toBe(0);
    clock.t += 200_000;
    orch.heartbeat(t.id, 'r1');
    expect(orch.sweep().expiredExecutions).toBe(1);
    const e = store.executions.get(ex.id)!;
    expect(e.status).toBe('failed');
    expect(e.failureReason).toBe('deadline_exceeded');
    expect(store.tasks.filter((x) => x.executionId === ex.id).every((x) => x.status === 'cancelled')).toBe(true);
    expect(store.eventsFor(ex.id).some((e2) => e2.type === 'alert.raised' && e2.payload.code === 'deadline_exceeded')).toBe(true);
  });

  it('execução parada esperando aprovação não estoura o prazo', () => {
    const { clock, orch, draft, store } = setup({ maxExecutionMs: 3_600_000 });
    const ex = draft([{ id: 'a', title: 'Deploy', agentId: 'ag', dependsOn: [], risk: 'high' }]);
    orch.startExecution(ex.id);
    clock.t += 10 * 3_600_000;
    expect(orch.sweep().expiredExecutions).toBe(0);
    expect(store.executions.get(ex.id)!.status).toBe('waiting_approval');
  });
});

describe('relatórios duplicados, atrasados ou de tentativas antigas', () => {
  it('concluir duas vezes aplica uma só (o uso não é contado em dobro)', () => {
    const { orch, draft, one, store } = setup();
    const ex = draft(one);
    orch.startExecution(ex.id);
    const t = orch.claimTask('org-a', 'r1')!;
    expect(orch.completeTask(t.id, { output: 'ok', usage: USAGE }, { attempt: 1 })).toBe('applied');
    expect(orch.completeTask(t.id, { output: 'ok', usage: USAGE }, { attempt: 1 })).toBe('ignored');
    expect(store.executions.get(ex.id)!.inputTokens).toBe(10);
  });

  it('relatório de uma tentativa antiga não afeta a tentativa atual', () => {
    const { clock, orch, draft, one, store } = setup({ backoffBaseMs: 0 });
    const ex = draft(one);
    orch.startExecution(ex.id);
    const first = orch.claimTask('org-a', 'r-lento')!; // tentativa 1
    clock.t += 61_000;
    orch.sweep(); // lease vence, volta para a fila
    const second = orch.claimTask('org-a', 'r-novo')!; // tentativa 2
    expect(second.attempts).toBe(2);

    // O Runner lento acorda e reporta a tentativa 1.
    expect(orch.completeTask(first.id, { output: 'velho', usage: USAGE }, { attempt: 1 })).toBe('ignored');
    expect(orch.failTask(first.id, 'tardio', { attempt: 1 })).toBe('ignored');
    const t = store.tasks.get(first.id)!;
    expect(t.status).toBe('running');
    expect(t.runnerId).toBe('r-novo');
    expect(store.executions.get(ex.id)!.inputTokens).toBe(0);

    expect(orch.completeTask(second.id, { output: 'novo', usage: USAGE }, { attempt: 2 })).toBe('applied');
    expect(store.executions.get(ex.id)!.status).toBe('succeeded');
  });

  it('relatório depois do cancelamento é ignorado, sem erro', () => {
    const { orch, draft, one, store } = setup();
    const ex = draft(one);
    orch.startExecution(ex.id);
    const t = orch.claimTask('org-a', 'r1')!;
    orch.cancelExecution(ex.id, 'u');
    expect(orch.completeTask(t.id, { output: 'x', usage: USAGE }, { attempt: 1 })).toBe('ignored');
    expect(orch.failTask(t.id, 'x', { attempt: 1 })).toBe('ignored');
    expect(store.executions.get(ex.id)!.status).toBe('cancelled');
  });

  it('concluir uma tarefa que nunca rodou continua sendo um erro de transição', () => {
    const { orch, draft, store } = setup();
    const ex = draft([
      { id: 'a', title: 'A', agentId: 'ag', dependsOn: [], risk: 'low' },
      { id: 'b', title: 'B', agentId: 'ag', dependsOn: ['a'], risk: 'low' },
    ]);
    orch.startExecution(ex.id);
    const pending = store.tasks.filter((x) => x.executionId === ex.id && x.status === 'pending')[0]!;
    expect(() => orch.completeTask(pending.id, { output: 'x', usage: USAGE })).toThrow(/transi/i);
  });
});
