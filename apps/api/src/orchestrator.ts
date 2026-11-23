import { randomUUID } from 'node:crypto';
import {
  canTransitionTask,
  costFor,
  isTerminalTask,
  type RiskLevel,
  type TaskStatus,
  type Usage,
} from '@command-ai/shared';
import type { Approval, Execution, Store, Task } from './store.ts';

export interface PlanTask {
  id: string;
  title: string;
  agentId: string;
  dependsOn: string[];
  risk: RiskLevel;
}

/** Limites do plano que o agente pode ampliar. */
export const MAX_TASKS_PER_EXECUTION = 25;
export const MAX_SUBTASK_DEPTH = 2;

export class OrchestratorError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Valida o plano: não vazio, ids únicos, dependências existentes e sem ciclos. */
export function validatePlan(tasks: PlanTask[]): string[] {
  const errors: string[] = [];
  if (tasks.length === 0) return ['O plano precisa ter ao menos uma tarefa.'];

  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) errors.push(`Tarefa duplicada: ${t.id}`);
    ids.add(t.id);
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (dep === t.id) errors.push(`A tarefa ${t.id} depende dela mesma (ciclo).`);
      else if (!ids.has(dep)) errors.push(`A tarefa ${t.id} depende de tarefa inexistente: ${dep}`);
    }
  }
  if (errors.length > 0) return errors;

  // Ordenação topológica (Kahn) para detectar ciclos.
  const indegree = new Map(tasks.map((t) => [t.id, t.dependsOn.length]));
  const queue = tasks.filter((t) => t.dependsOn.length === 0).map((t) => t.id);
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    visited++;
    for (const t of tasks) {
      if (t.dependsOn.includes(current)) {
        const left = (indegree.get(t.id) ?? 0) - 1;
        indegree.set(t.id, left);
        if (left === 0) queue.push(t.id);
      }
    }
  }
  if (visited !== tasks.length) errors.push('O plano contém um ciclo de dependências.');
  return errors;
}

const HIGH_RISK = /\b(deploy|produ[cç][aã]o|prod\b|apag\w*|delet\w*|exclu\w*|drop|credencia\w*|senha|secret\w*|migra[cç][aã]o)\b/i;

/**
 * Plano inicial determinístico. O MVP não chama um modelo para planejar:
 * a decomposição vira um provedor de plano na etapa 3, e o resultado continua
 * passando por validatePlan e por edição humana antes de executar.
 */
export function planFromGoal(goal: string, agentId: string): PlanTask[] {
  const risky = HIGH_RISK.test(goal);
  return [
    { id: 'analise', title: `Analisar o contexto: ${goal}`.slice(0, 200), agentId, dependsOn: [], risk: 'low' },
    {
      id: 'execucao',
      title: `Executar: ${goal}`.slice(0, 200),
      agentId,
      dependsOn: ['analise'],
      risk: risky ? 'high' : 'medium',
    },
    { id: 'revisao', title: 'Revisar o resultado e resumir', agentId, dependsOn: ['execucao'], risk: 'low' },
  ];
}

export interface CreateDraftInput {
  organizationId: string;
  projectId: string;
  agentId: string;
  goal: string;
  budgetUsd: number;
  createdBy: string;
  tasks?: PlanTask[];
}

const MAX_ATTEMPTS = 3;

export interface OrchestratorOptions {
  /** Relógio injetável (testes). */
  now?: () => number;
  /** Quanto tempo uma tarefa pode ficar sem heartbeat antes de ser considerada perdida. */
  leaseMs?: number;
  /** Espera antes da nova tentativa: base * 2^(tentativa-1), até o teto. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Prazo total de uma execução em andamento. */
  maxExecutionMs?: number;
}

const DEFAULT_OPTIONS = {
  leaseMs: 60_000,
  backoffBaseMs: 5_000,
  backoffMaxMs: 300_000,
  maxExecutionMs: 2 * 60 * 60 * 1000,
};

export type ReportOutcome = 'applied' | 'ignored';

export class Orchestrator {
  private opts: Required<OrchestratorOptions>;

  constructor(
    private store: Store,
    options: OrchestratorOptions = {},
  ) {
    this.opts = { now: () => Date.now(), ...DEFAULT_OPTIONS, ...options };
  }

  get leaseMs(): number {
    return this.opts.leaseMs;
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  private backoffMs(attempts: number): number {
    return Math.min(this.opts.backoffBaseMs * 2 ** Math.max(0, attempts - 1), this.opts.backoffMaxMs);
  }

  /* ---------------- plano ---------------- */

  createDraft(input: CreateDraftInput): Execution {
    const plan = input.tasks ?? planFromGoal(input.goal, input.agentId);
    const errors = validatePlan(plan);
    if (errors.length) throw new OrchestratorError('invalid_plan', errors.join(' '));

    const exec = this.store.executions.insert({
      id: randomUUID(),
      organizationId: input.organizationId,
      projectId: input.projectId,
      agentId: input.agentId,
      goal: input.goal,
      status: 'draft',
      budgetUsd: input.budgetUsd,
      costUsd: 0,
      costUnknown: false,
      inputTokens: 0,
      outputTokens: 0,
      planVersion: 1,
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
    });
    this.writePlan(exec, plan);
    return exec;
  }

  replacePlan(executionId: string, plan: PlanTask[]): Execution {
    const exec = this.mustExecution(executionId);
    if (exec.status !== 'draft') throw new OrchestratorError('not_draft', 'Só é possível editar o plano antes de iniciar.');
    const errors = validatePlan(plan);
    if (errors.length) throw new OrchestratorError('invalid_plan', errors.join(' '));
    for (const t of this.store.tasks.filter((x) => x.executionId === executionId)) this.store.tasks.delete(t.id);
    const next = this.store.executions.update(executionId, { planVersion: exec.planVersion + 1 });
    this.writePlan(next, plan);
    return next;
  }

  private writePlan(exec: Execution, plan: PlanTask[]): void {
    plan.forEach((t, position) => {
      this.store.tasks.insert({
        id: `${exec.id}:${t.id}`,
        executionId: exec.id,
        organizationId: exec.organizationId,
        planId: t.id,
        title: t.title,
        agentId: t.agentId,
        dependsOn: t.dependsOn.map((d) => `${exec.id}:${d}`),
        risk: t.risk,
        status: 'pending',
        attempts: 0,
        maxAttempts: MAX_ATTEMPTS,
        approved: false,
        position,
      });
    });
  }

  /* ---------------- ciclo de vida ---------------- */

  startExecution(executionId: string): Execution {
    const exec = this.mustExecution(executionId);
    if (exec.status !== 'draft') throw new OrchestratorError('not_draft', 'A execução já foi iniciada.');
    const nowMs = this.opts.now();
    this.setExecution(exec.id, 'running', { startedAt: this.iso(nowMs), deadlineAt: this.iso(nowMs + this.opts.maxExecutionMs) });
    this.promoteReady(exec.id);
    return this.mustExecution(executionId);
  }

  cancelExecution(executionId: string, actor: string): Execution {
    const exec = this.mustExecution(executionId);
    if (['succeeded', 'failed', 'cancelled'].includes(exec.status)) return exec;
    this.cancelOpenTasks(exec.id);
    this.finish(exec.id, 'cancelled');
    this.store.audit({ organizationId: exec.organizationId, actor, action: 'execution.cancelled', target: exec.id });
    return this.mustExecution(executionId);
  }

  /** O Runner pede trabalho. Só enxerga tarefas da própria organização. */
  claimTask(organizationId: string, runnerId: string): Task | null {
    const nowMs = this.opts.now();
    const candidates = this.store.tasks
      .filter((t) => t.organizationId === organizationId && t.status === 'queued')
      .filter((t) => !t.notBefore || Date.parse(t.notBefore) <= nowMs) // respeita a espera progressiva
      .filter((t) => this.store.executions.get(t.executionId)?.status === 'running')
      .sort((a, b) => a.position - b.position);
    const task = candidates[0];
    if (!task) return null;
    this.setTask(task.id, 'running', {
      attempts: task.attempts + 1,
      runnerId,
      notBefore: undefined,
      lastUsageTurn: 0, // a numeração de turnos recomeça a cada tentativa
      lastHeartbeatAt: this.iso(nowMs),
      leaseExpiresAt: this.iso(nowMs + this.opts.leaseMs),
    });
    return this.store.tasks.get(task.id)!;
  }

  /**
   * O Runner avisa que a tarefa continua viva e renova o lease. A resposta diz se ele deve parar
   * (execução cancelada ou encerrada): é assim que o cancelamento chega ao Runner.
   */
  heartbeat(taskId: string, runnerId: string): { ok: boolean; cancel: boolean } {
    const task = this.store.tasks.get(taskId);
    if (!task || (task.runnerId && task.runnerId !== runnerId)) return { ok: false, cancel: false };
    const exec = this.store.executions.get(task.executionId);
    if (task.status === 'cancelled' || (exec && ['cancelled', 'failed', 'succeeded'].includes(exec.status))) {
      return { ok: true, cancel: true };
    }
    if (task.status !== 'running') return { ok: false, cancel: false };
    const nowMs = this.opts.now();
    this.store.tasks.update(task.id, { lastHeartbeatAt: this.iso(nowMs), leaseExpiresAt: this.iso(nowMs + this.opts.leaseMs) });
    return { ok: true, cancel: false };
  }

  /**
   * Uso de uma interação com o modelo, enviado enquanto a tarefa roda (não só no fim): assim o orçamento da execução
   * é aplicado no meio da tarefa. Idempotente por `turn` e protegido contra tentativas antigas.
   * `cancel: true` manda o Runner parar (orçamento estourado, execução cancelada ou falha).
   */
  addTaskUsage(taskId: string, usage: Usage, opts: { turn: number; attempt?: number }): { applied: boolean; cancel: boolean } {
    const task = this.mustTask(taskId);
    const executionId = task.executionId;
    const mustStop = () => {
      const t = this.store.tasks.get(taskId)!;
      const e = this.store.executions.get(executionId)!;
      return t.status === 'cancelled' || e.status === 'failed' || e.status === 'cancelled';
    };
    if (opts.attempt !== undefined && opts.attempt !== task.attempts) return { applied: false, cancel: false };
    if (task.status !== 'running') return { applied: false, cancel: mustStop() };
    if (opts.turn <= (task.lastUsageTurn ?? 0)) return { applied: false, cancel: false };
    this.store.tasks.update(task.id, { lastUsageTurn: opts.turn });
    this.recordUsage(executionId, task.id, usage);
    return { applied: true, cancel: mustStop() };
  }

  /* ---------------- aprovação humana de ferramentas ---------------- */

  /**
   * O agente pede para usar uma ferramenta de risco. A tarefa continua `running` (o Runner segue batendo o heartbeat
   * enquanto espera). Rejeitar não falha a tarefa: o agente recebe a recusa e se adapta.
   */
  requestToolApproval(
    taskId: string,
    req: { tool: string; summary: string; risk: 'medium' | 'high'; argsPreview?: string },
    opts: { attempt?: number } = {},
  ): Approval {
    const task = this.mustTask(taskId);
    if (opts.attempt !== undefined && opts.attempt !== task.attempts) {
      throw new OrchestratorError('stale_attempt', 'Pedido de uma tentativa antiga: a tentativa atual é outra.');
    }
    if (task.status !== 'running') {
      throw new OrchestratorError('invalid_transition', `Transição inválida: ${task.status} não pode pedir aprovação`);
    }
    const pending = this.store.approvals.filter((a) => a.taskId === taskId && a.kind === 'tool' && a.status === 'pending');
    if (pending.length >= 5) throw new OrchestratorError('too_many_pending', 'Há pedidos pendentes demais para esta tarefa.');

    const approval = this.store.approvals.insert({
      id: randomUUID(),
      organizationId: task.organizationId,
      executionId: task.executionId,
      taskId,
      status: 'pending',
      kind: 'tool',
      tool: { name: req.tool, summary: req.summary, risk: req.risk, ...(req.argsPreview ? { argsPreview: req.argsPreview } : {}) },
      requestedAt: new Date().toISOString(),
    });
    this.store.emit(task.executionId, taskId, 'approval.requested', {
      approvalId: approval.id,
      kind: 'tool',
      risk: req.risk,
      title: `${req.tool}: ${req.summary}`,
    });
    return approval;
  }

  /** Situação de um pedido de ferramenta, vista pelo Runner dono da tarefa. */
  toolApprovalStatus(taskId: string, approvalId: string): { status: Approval['status']; reason: string | null } | null {
    const a = this.store.approvals.get(approvalId);
    if (!a || a.kind !== 'tool' || a.taskId !== taskId) return null;
    return { status: a.status, reason: a.reason ?? null };
  }

  /** A tarefa deixou de rodar: pedidos de ferramenta ainda pendentes perdem o sentido e são encerrados. */
  private closeToolApprovals(taskId: string): void {
    for (const a of this.store.approvals.filter((x) => x.taskId === taskId && x.kind === 'tool' && x.status === 'pending')) {
      this.store.approvals.update(a.id, { status: 'rejected', decidedAt: new Date().toISOString(), decidedBy: 'system', reason: 'tarefa encerrada' });
      this.store.emit(a.executionId, taskId, 'approval.decided', { approvalId: a.id, decision: 'rejected', reason: 'tarefa encerrada' });
    }
  }

  appendLog(taskId: string, line: string): void {
    const task = this.mustTask(taskId);
    this.store.emit(task.executionId, task.id, 'log.appended', { line });
  }

  /**
   * Relatório do Runner. Idempotente e protegido contra tentativas antigas: se `attempt` não for o da
   * tentativa atual, ou a tarefa já terminou, o relatório é ignorado (sem erro e sem efeito).
   */
  private isStale(task: Task, attempt?: number): boolean {
    if (attempt !== undefined && attempt !== task.attempts) return true;
    if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') return true;
    return task.status === 'queued' && task.attempts > 0; // já voltou para a fila (lease vencido)
  }

  completeTask(taskId: string, result: { output: string; usage: Usage; workspaceCommit?: string }, opts: { attempt?: number } = {}): ReportOutcome {
    const task = this.mustTask(taskId);
    if (this.isStale(task, opts.attempt)) return 'ignored';
    this.setTask(task.id, 'done', { output: result.output, workspaceCommit: result.workspaceCommit, leaseExpiresAt: undefined });
    this.recordUsage(task.executionId, task.id, result.usage);
    const exec = this.mustExecution(task.executionId);
    if (exec.status !== 'running' && exec.status !== 'waiting_approval') return 'applied'; // já encerrada (orçamento)
    this.promoteReady(task.executionId);
    return 'applied';
  }

  /**
   * O agente acrescenta subtarefas ao plano. Elas dependem da tarefa que as criou; as tarefas que esperavam
   * por ela passam a esperar também pelas folhas das subtarefas. Tudo dentro de limites fixos.
   */
  addSubtasks(taskId: string, specs: PlanTask[], opts: { attempt?: number } = {}): string[] {
    const task = this.mustTask(taskId);
    if (opts.attempt !== undefined && opts.attempt !== task.attempts) {
      throw new OrchestratorError('stale_attempt', 'Pedido de uma tentativa antiga: a tentativa atual é outra.');
    }
    const exec = this.mustExecution(task.executionId);
    if (task.status !== 'running' || (exec.status !== 'running' && exec.status !== 'waiting_approval')) {
      throw new OrchestratorError('invalid_transition', `Transição inválida: ${task.status} não pode criar subtarefas`);
    }
    const errors = validatePlan(specs);
    if (errors.length) throw new OrchestratorError('invalid_plan', errors.join(' '));

    const all = this.store.tasks.filter((t) => t.executionId === exec.id);
    const clash = specs.find((s) => all.some((t) => t.planId === s.id));
    if (clash) throw new OrchestratorError('duplicate_task', `Já existe uma tarefa com o id "${clash.id}" neste plano.`);
    const depth = (task.depth ?? 0) + 1;
    if (depth > MAX_SUBTASK_DEPTH) throw new OrchestratorError('plan_limit', `Subtarefas só podem ir até a geração ${MAX_SUBTASK_DEPTH}.`);
    if (all.length + specs.length > MAX_TASKS_PER_EXECUTION) {
      throw new OrchestratorError('plan_limit', `O plano passaria de ${MAX_TASKS_PER_EXECUTION} tarefas.`);
    }

    const full = (id: string) => `${exec.id}:${id}`;
    const referenced = new Set(specs.flatMap((s) => s.dependsOn));
    const leaves = specs.filter((s) => !referenced.has(s.id)).map((s) => full(s.id));
    const basePosition = Math.max(...all.map((t) => t.position), 0) + 1;
    const rank = { low: 0, medium: 1, high: 2 } as const;

    specs.forEach((s, i) => {
      this.store.tasks.insert({
        id: full(s.id),
        executionId: exec.id,
        organizationId: exec.organizationId,
        planId: s.id,
        title: s.title,
        agentId: s.agentId,
        // Sem dependências no pedido, a subtarefa espera a tarefa que a criou (e herda o resultado dela).
        dependsOn: s.dependsOn.length ? s.dependsOn.map(full) : [task.id],
        // Nunca menos arriscada que a tarefa que a criou.
        risk: rank[s.risk] < rank[task.risk] ? task.risk : s.risk,
        status: 'pending',
        attempts: 0,
        maxAttempts: MAX_ATTEMPTS,
        approved: false,
        position: basePosition + i,
        parentTaskId: task.id,
        depth,
      });
    });
    // Quem esperava pela tarefa criadora passa a esperar também pelo trabalho novo.
    for (const t of all) {
      if (t.status === 'pending' && t.dependsOn.includes(task.id)) this.store.tasks.update(t.id, { dependsOn: [...t.dependsOn, ...leaves] });
    }
    this.store.executions.update(exec.id, { planVersion: exec.planVersion + 1 });
    this.store.emit(exec.id, task.id, 'plan.updated', { added: specs.map((s) => s.id), by: task.planId, titles: specs.map((s) => s.title) });
    return specs.map((s) => s.id);
  }

  failTask(taskId: string, reason: string, opts: { attempt?: number } = {}): ReportOutcome {
    const task = this.mustTask(taskId);
    if (this.isStale(task, opts.attempt)) return 'ignored';
    const exec = this.mustExecution(task.executionId);
    if (task.status !== 'running') {
      throw new OrchestratorError('invalid_transition', `Transição inválida: ${task.status} -> failed`);
    }
    this.retryOrFail(task, exec, reason);
    return 'applied';
  }

  /** Nova tentativa com espera progressiva, ou falha definitiva quando as tentativas acabam. */
  private retryOrFail(task: Task, exec: Execution, reason: string, logLine?: string): void {
    if (task.attempts < task.maxAttempts && exec.status === 'running') {
      const wait = this.backoffMs(task.attempts);
      this.store.emit(exec.id, task.id, 'log.appended', {
        line: logLine ?? `Falha (${reason}). Nova tentativa ${task.attempts + 1}/${task.maxAttempts} em ${Math.round(wait / 1000)} s.`,
      });
      this.setTask(task.id, 'queued', { error: reason, notBefore: this.iso(this.opts.now() + wait), leaseExpiresAt: undefined });
      return;
    }
    this.setTask(task.id, 'failed', { error: reason, leaseExpiresAt: undefined });
    this.failExecution(exec.id, 'task_failed');
  }

  /**
   * Varredura de recuperação (rodada pelo Worker a cada poucos segundos e no boot):
   * 1. encerra execuções que passaram do prazo;
   * 2. devolve à fila (ou falha) as tarefas cujo lease venceu, ou seja, cujo Runner sumiu.
   */
  sweep(): { requeued: number; failed: number; expiredExecutions: number } {
    const nowMs = this.opts.now();
    const out = { requeued: 0, failed: 0, expiredExecutions: 0 };

    for (const exec of this.store.executions.filter((e) => e.status === 'running' && !!e.deadlineAt && Date.parse(e.deadlineAt) <= nowMs)) {
      this.store.emit(exec.id, null, 'alert.raised', {
        level: 'error',
        code: 'deadline_exceeded',
        message: 'A execução passou do prazo máximo e foi encerrada.',
      });
      this.cancelOpenTasks(exec.id);
      this.failExecution(exec.id, 'deadline_exceeded');
      out.expiredExecutions++;
    }

    for (const task of this.store.tasks.filter((t) => t.status === 'running' && !!t.leaseExpiresAt && Date.parse(t.leaseExpiresAt) <= nowMs)) {
      const exec = this.mustExecution(task.executionId);
      const willRetry = task.attempts < task.maxAttempts && exec.status === 'running';
      this.retryOrFail(task, exec, 'lease_expired', `Runner sem resposta (lease expirado). ${willRetry ? `Nova tentativa ${task.attempts + 1}/${task.maxAttempts}.` : 'Tentativas esgotadas.'}`);
      if (willRetry) out.requeued++;
      else out.failed++;
    }
    return out;
  }

  recordUsage(executionId: string, taskId: string | null, usage: Usage): void {
    const exec = this.mustExecution(executionId);
    const cost = costFor(usage.model, usage);
    const next = this.store.executions.update(executionId, {
      inputTokens: exec.inputTokens + usage.inputTokens,
      outputTokens: exec.outputTokens + usage.outputTokens,
      cacheReadTokens: (exec.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
      cacheWriteTokens: (exec.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
      costUsd: exec.costUsd + (cost ?? 0),
      costUnknown: exec.costUnknown || cost === null,
    });
    this.store.emit(executionId, taskId, 'usage.updated', {
      inputTokens: next.inputTokens,
      outputTokens: next.outputTokens,
      cacheReadTokens: next.cacheReadTokens ?? 0,
      cacheWriteTokens: next.cacheWriteTokens ?? 0,
      costUsd: next.costUsd,
      costAvailable: !next.costUnknown,
      budgetUsd: next.budgetUsd,
    });

    if (next.status !== 'running' && next.status !== 'waiting_approval') return;
    if (next.costUsd >= next.budgetUsd) {
      this.store.emit(executionId, null, 'alert.raised', {
        level: 'error',
        code: 'budget_exceeded',
        message: `Orçamento de US$ ${next.budgetUsd.toFixed(2)} atingido. Execução interrompida.`,
      });
      this.cancelOpenTasks(executionId);
      this.failExecution(executionId, 'budget_exceeded');
    } else if (!next.budgetWarned && next.costUsd >= next.budgetUsd * 0.8) {
      this.store.executions.update(executionId, { budgetWarned: true });
      this.store.emit(executionId, null, 'alert.raised', {
        level: 'warning',
        code: 'budget_80',
        message: 'O consumo chegou a 80% do orçamento da execução.',
      });
    }
  }

  /* ---------------- aprovações ---------------- */

  decideApproval(approvalId: string, decision: 'approved' | 'rejected', actor: string, reason?: string): void {
    const approval = this.store.approvals.get(approvalId);
    if (!approval) throw new OrchestratorError('not_found', 'Aprovação não encontrada.');
    if (approval.status !== 'pending') throw new OrchestratorError('already_decided', 'Esta aprovação já foi decidida.');

    this.store.approvals.update(approvalId, {
      status: decision,
      decidedAt: new Date().toISOString(),
      decidedBy: actor,
      reason,
    });
    this.store.emit(approval.executionId, approval.taskId, 'approval.decided', { approvalId, decision, reason: reason ?? null });
    this.store.audit({
      organizationId: approval.organizationId,
      actor,
      action: `approval.${decision}`,
      target: approval.taskId,
      detail: { reason: reason ?? null },
    });

    // Pedido de ferramenta: só registra a decisão. A tarefa segue rodando e o agente decide o que fazer com a resposta.
    if (approval.kind === 'tool') return;

    const task = this.mustTask(approval.taskId);
    if (decision === 'approved') {
      this.store.tasks.update(task.id, { approved: true });
      this.setTask(task.id, 'queued');
      const exec = this.mustExecution(task.executionId);
      if (exec.status === 'waiting_approval') this.setExecution(exec.id, 'running');
    } else {
      this.setTask(task.id, 'failed', { error: 'Aprovação rejeitada' });
      this.cancelOpenTasks(task.executionId);
      this.failExecution(task.executionId, 'approval_rejected');
    }
  }

  /* ---------------- internos ---------------- */

  /** Move tarefas pendentes cujas dependências terminaram; pede aprovação para risco alto. */
  private promoteReady(executionId: string): void {
    const tasks = this.store.tasks.filter((t) => t.executionId === executionId);
    const done = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));

    for (const task of tasks.filter((t) => t.status === 'pending')) {
      if (!task.dependsOn.every((d) => done.has(d))) continue;
      if (task.risk === 'high' && !task.approved) {
        this.setTask(task.id, 'waiting_approval');
        const approval = this.store.approvals.insert({
          id: randomUUID(),
          organizationId: task.organizationId,
          executionId,
          taskId: task.id,
          status: 'pending',
          requestedAt: new Date().toISOString(),
        });
        this.store.emit(executionId, task.id, 'approval.requested', { approvalId: approval.id, risk: task.risk, title: task.title });
      } else {
        this.setTask(task.id, 'queued');
      }
    }

    const fresh = this.store.tasks.filter((t) => t.executionId === executionId);
    const exec = this.mustExecution(executionId);
    if (fresh.length > 0 && fresh.every((t) => t.status === 'done')) {
      this.finish(executionId, 'succeeded');
    } else if (fresh.some((t) => t.status === 'waiting_approval') && !fresh.some((t) => t.status === 'queued' || t.status === 'running')) {
      if (exec.status !== 'waiting_approval') this.setExecution(executionId, 'waiting_approval');
    } else if (exec.status === 'waiting_approval') {
      this.setExecution(executionId, 'running');
    }
  }

  private cancelOpenTasks(executionId: string): void {
    for (const t of this.store.tasks.filter((x) => x.executionId === executionId)) {
      if (!isTerminalTask(t.status)) this.setTask(t.id, 'cancelled');
    }
  }

  private failExecution(executionId: string, reason: string): void {
    this.cancelOpenTasks(executionId);
    this.finish(executionId, 'failed', reason);
  }

  private finish(executionId: string, status: 'succeeded' | 'failed' | 'cancelled', failureReason?: string): void {
    this.setExecution(executionId, status, { finishedAt: new Date().toISOString(), ...(failureReason ? { failureReason } : {}) });
  }

  private setExecution(id: string, status: Execution['status'], patch: Partial<Execution> = {}): void {
    const current = this.mustExecution(id);
    this.store.executions.update(id, { ...patch, status });
    this.store.emit(id, null, 'execution.state_changed', {
      from: current.status,
      to: status,
      reason: patch.failureReason ?? null,
    });
  }

  private setTask(id: string, to: TaskStatus, patch: Partial<Task> = {}): void {
    const task = this.mustTask(id);
    if (!canTransitionTask(task.status, to)) {
      throw new OrchestratorError('invalid_transition', `Transição inválida: ${task.status} -> ${to}`);
    }
    this.store.tasks.update(id, { ...patch, status: to });
    this.store.emit(task.executionId, id, 'task.state_changed', { from: task.status, to, title: task.title });
    if (task.status === 'running' && to !== 'running') this.closeToolApprovals(id);
  }

  private mustExecution(id: string): Execution {
    const e = this.store.executions.get(id);
    if (!e) throw new OrchestratorError('not_found', 'Execução não encontrada.');
    return e;
  }

  private mustTask(id: string): Task {
    const t = this.store.tasks.get(id);
    if (!t) throw new OrchestratorError('not_found', 'Tarefa não encontrada.');
    return t;
  }
}
