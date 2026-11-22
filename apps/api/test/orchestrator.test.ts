import { describe, expect, it } from 'vitest';
import { createStore } from '../src/store.ts';
import { Orchestrator, validatePlan, type PlanTask } from '../src/orchestrator.ts';

function setup() {
  const store = createStore();
  const org = store.organizations.insert({ id: 'org-a', name: 'Acme' });
  const otherOrg = store.organizations.insert({ id: 'org-b', name: 'Beta' });
  const agent = store.agents.insert({
    id: 'agent-1',
    organizationId: org.id,
    name: 'Auditor',
    role: 'Auditoria',
    instructions: 'Audite com cuidado.',
    providerKind: 'anthropic',
    model: 'claude-sonnet-5-5',
    budgetUsd: 5,
  });
  const project = store.projects.insert({
    id: 'proj-1',
    organizationId: org.id,
    name: 'Repo',
    workspacePath: '/work/repo',
  });
  // Sem espera entre tentativas aqui: estes testes cobrem as regras, não o relógio (ver lease.test.ts).
  const orch = new Orchestrator(store, { backoffBaseMs: 0 });
  return { store, org, otherOrg, agent, project, orch };
}

const chainPlan: PlanTask[] = [
  { id: 'a', title: 'Analisar', agentId: 'agent-1', dependsOn: [], risk: 'low' },
  { id: 'b', title: 'Executar', agentId: 'agent-1', dependsOn: ['a'], risk: 'low' },
  { id: 'c', title: 'Revisar', agentId: 'agent-1', dependsOn: ['b'], risk: 'low' },
];

function draft(ctx: ReturnType<typeof setup>, tasks: PlanTask[] = chainPlan, budgetUsd = 5) {
  return ctx.orch.createDraft({
    organizationId: ctx.org.id,
    projectId: ctx.project.id,
    agentId: ctx.agent.id,
    goal: 'Auditar o repositório',
    budgetUsd,
    createdBy: 'user-1',
    tasks,
  });
}

describe('validatePlan', () => {
  it('accepts a valid dependency graph', () => {
    expect(validatePlan(chainPlan)).toEqual([]);
  });

  it('rejects an empty plan', () => {
    expect(validatePlan([])).not.toEqual([]);
  });

  it('rejects duplicate ids', () => {
    const errors = validatePlan([
      { id: 'a', title: 'x', agentId: 'agent-1', dependsOn: [], risk: 'low' },
      { id: 'a', title: 'y', agentId: 'agent-1', dependsOn: [], risk: 'low' },
    ]);
    expect(errors.join(' ')).toMatch(/duplicad/i);
  });

  it('rejects dependencies on unknown tasks', () => {
    const errors = validatePlan([
      { id: 'a', title: 'x', agentId: 'agent-1', dependsOn: ['ghost'], risk: 'low' },
    ]);
    expect(errors.join(' ')).toMatch(/inexistente/i);
  });

  it('rejects cycles', () => {
    const errors = validatePlan([
      { id: 'a', title: 'x', agentId: 'agent-1', dependsOn: ['b'], risk: 'low' },
      { id: 'b', title: 'y', agentId: 'agent-1', dependsOn: ['a'], risk: 'low' },
    ]);
    expect(errors.join(' ')).toMatch(/ciclo/i);
  });
});

describe('Orchestrator', () => {
  it('queues only tasks without dependencies when the execution starts', () => {
    const ctx = setup();
    const exec = draft(ctx);
    ctx.orch.startExecution(exec.id);
    const tasks = ctx.store.tasks.filter((t) => t.executionId === exec.id);
    const byId = Object.fromEntries(tasks.map((t) => [t.id.split(':').pop(), t.status]));
    expect(byId).toEqual({ a: 'queued', b: 'pending', c: 'pending' });
    expect(ctx.store.executions.get(exec.id)?.status).toBe('running');
  });

  it('promotes the next task when its dependency completes and succeeds at the end', () => {
    const ctx = setup();
    const exec = draft(ctx);
    ctx.orch.startExecution(exec.id);

    const claimed = ctx.orch.claimTask(ctx.org.id, 'runner-1');
    expect(claimed?.title).toBe('Analisar');
    ctx.orch.completeTask(claimed!.id, { output: 'ok', usage: { model: 'claude-sonnet-5-5', inputTokens: 100, outputTokens: 50 } });

    const second = ctx.orch.claimTask(ctx.org.id, 'runner-1');
    expect(second?.title).toBe('Executar');
    ctx.orch.completeTask(second!.id, { output: 'ok', usage: { model: 'claude-sonnet-5-5', inputTokens: 1, outputTokens: 1 } });
    const third = ctx.orch.claimTask(ctx.org.id, 'runner-1');
    ctx.orch.completeTask(third!.id, { output: 'ok', usage: { model: 'claude-sonnet-5-5', inputTokens: 1, outputTokens: 1 } });

    expect(ctx.store.executions.get(exec.id)?.status).toBe('succeeded');
  });

  it('holds a high-risk task until a human approves it', () => {
    const ctx = setup();
    const exec = draft(ctx, [
      { id: 'a', title: 'Deploy', agentId: 'agent-1', dependsOn: [], risk: 'high' },
      { id: 'b', title: 'Depois', agentId: 'agent-1', dependsOn: ['a'], risk: 'low' },
    ]);
    ctx.orch.startExecution(exec.id);

    expect(ctx.orch.claimTask(ctx.org.id, 'runner-1')).toBeNull();
    const approval = ctx.store.approvals.filter((a) => a.executionId === exec.id)[0];
    expect(approval?.status).toBe('pending');
    expect(ctx.store.executions.get(exec.id)?.status).toBe('waiting_approval');

    ctx.orch.decideApproval(approval!.id, 'approved', 'user-1');
    expect(ctx.orch.claimTask(ctx.org.id, 'runner-1')?.title).toBe('Deploy');
  });

  it('fails the execution and cancels the rest when an approval is rejected', () => {
    const ctx = setup();
    const exec = draft(ctx, [
      { id: 'a', title: 'Apagar', agentId: 'agent-1', dependsOn: [], risk: 'high' },
      { id: 'b', title: 'Depois', agentId: 'agent-1', dependsOn: ['a'], risk: 'low' },
    ]);
    ctx.orch.startExecution(exec.id);
    const approval = ctx.store.approvals.filter((a) => a.executionId === exec.id)[0];
    ctx.orch.decideApproval(approval!.id, 'rejected', 'user-1', 'Muito arriscado');

    const statuses = ctx.store.tasks.filter((t) => t.executionId === exec.id).map((t) => t.status);
    expect(statuses).toEqual(['failed', 'cancelled']);
    const exe = ctx.store.executions.get(exec.id);
    expect(exe?.status).toBe('failed');
    expect(exe?.failureReason).toBe('approval_rejected');
  });

  it('retries a failed task until maxAttempts, then fails the execution', () => {
    const ctx = setup();
    const exec = draft(ctx, [{ id: 'a', title: 'Instável', agentId: 'agent-1', dependsOn: [], risk: 'low' }]);
    ctx.orch.startExecution(exec.id);

    const first = ctx.orch.claimTask(ctx.org.id, 'runner-1');
    ctx.orch.failTask(first!.id, 'timeout');
    expect(ctx.store.tasks.get(first!.id)?.status).toBe('queued');

    const second = ctx.orch.claimTask(ctx.org.id, 'runner-1');
    ctx.orch.failTask(second!.id, 'timeout');
    const third = ctx.orch.claimTask(ctx.org.id, 'runner-1');
    expect(third).not.toBeNull();
    ctx.orch.failTask(third!.id, 'timeout');

    expect(ctx.store.tasks.get(first!.id)?.status).toBe('failed');
    expect(ctx.store.executions.get(exec.id)?.status).toBe('failed');
  });

  it('stops the execution as soon as the budget is exceeded', () => {
    const ctx = setup();
    const exec = draft(ctx, chainPlan, 0.01);
    ctx.orch.startExecution(exec.id);
    const claimed = ctx.orch.claimTask(ctx.org.id, 'runner-1');
    ctx.orch.completeTask(claimed!.id, {
      output: 'ok',
      usage: { model: 'claude-sonnet-5-5', inputTokens: 1_000_000, outputTokens: 1_000_000 },
    });

    const exe = ctx.store.executions.get(exec.id);
    expect(exe?.status).toBe('failed');
    expect(exe?.failureReason).toBe('budget_exceeded');
    const statuses = ctx.store.tasks.filter((t) => t.executionId === exec.id).map((t) => t.status);
    expect(statuses.every((s) => s === 'done' || s === 'cancelled')).toBe(true);
    const alerts = ctx.store.eventsFor(exec.id).filter((e) => e.type === 'alert.raised');
    expect(alerts.length).toBeGreaterThan(0);
  });

  it('never lets a runner from another organization claim a task', () => {
    const ctx = setup();
    const exec = draft(ctx);
    ctx.orch.startExecution(exec.id);
    expect(ctx.orch.claimTask(ctx.otherOrg.id, 'runner-beta')).toBeNull();
  });

  it('rejects an illegal transition, such as completing a task that never ran', () => {
    const ctx = setup();
    const exec = draft(ctx);
    ctx.orch.startExecution(exec.id);
    const pending = ctx.store.tasks.filter((t) => t.executionId === exec.id && t.status === 'pending')[0];
    expect(() =>
      ctx.orch.completeTask(pending!.id, { output: 'x', usage: { model: 'claude-sonnet-5-5', inputTokens: 0, outputTokens: 0 } }),
    ).toThrow(/transi/i);
  });

  it('cancels every non-terminal task when the execution is cancelled', () => {
    const ctx = setup();
    const exec = draft(ctx);
    ctx.orch.startExecution(exec.id);
    ctx.orch.cancelExecution(exec.id, 'user-1');
    expect(ctx.store.executions.get(exec.id)?.status).toBe('cancelled');
    const statuses = ctx.store.tasks.filter((t) => t.executionId === exec.id).map((t) => t.status);
    expect(statuses.every((s) => s === 'cancelled')).toBe(true);
  });
});
