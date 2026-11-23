import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { buildHierarchy } from '@command-ai/shared/hierarchy';
import { ExecutionGraph } from '../components/ExecutionGraph';
import { HierarchyChart } from '../components/HierarchyChart';
import { Button, cx, ErrorNote, money, RiskBadge, Section, Spinner, StateIcon, StatusBadge } from '../components/ui';
import { api, ApiError, type Agent, type AgentMessageView, type Approval, type EventEnvelope, type Execution, type Task } from '../lib/api';
import { useExecutionEvents, useQuery } from '../lib/hooks';
import { useI18n, type MessageKey } from '../lib/i18n';

interface Detail {
  execution: Execution;
  tasks: Task[];
  approvals: Approval[];
}

const REFRESH_ON = new Set(['task.state_changed', 'execution.state_changed', 'approval.requested', 'approval.decided', 'usage.updated', 'plan.updated', 'message.sent']);

export function ExecutionLive() {
  const { id } = useParams<{ id: string }>();
  const { t } = useI18n();
  const detail = useQuery(() => api<Detail>(`/executions/${id}`), [id]);
  const agentsQ = useQuery(() => api<{ items: Agent[] }>('/agents'));
  const messagesQ = useQuery(() => api<{ items: AgentMessageView[] }>(`/executions/${id}/messages`), [id]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [view, setView] = useState<'agents' | 'tasks' | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Atualiza o estado derivado (grafo, custo) quando chega um evento relevante, sem polling.
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { events, connected } = useExecutionEvents(id, (e) => {
    if (!REFRESH_ON.has(e.type)) return;
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      void detail.reload(true);
      if (e.type === 'message.sent') void messagesQ.reload(true);
    }, 150);
  });
  useEffect(() => () => clearTimeout(refreshTimer.current), []);

  const tasksById = useMemo(() => new Map((detail.data?.tasks ?? []).map((x) => [x.id, x])), [detail.data]);
  const agentList = agentsQ.data?.items ?? [];
  const agentTaskIds = useMemo(() => new Set((detail.data?.tasks ?? []).filter((x) => x.agentId === selectedAgent).map((x) => x.id)), [detail.data, selectedAgent]);
  const hierarchy = useMemo(
    () => buildHierarchy({ agents: agentList, tasks: detail.data?.tasks ?? [], messages: messagesQ.data?.items ?? [], withRequest: true, withResult: true }),
    [agentList, detail.data, messagesQ.data],
  );
  const hasTeam = agentList.some((a) => a.kind === 'orchestrator' || a.parentAgentId) || hierarchy.nodes.filter((n) => n.kind === 'agent').length > 1;
  const mode = view ?? (hasTeam ? 'agents' : 'tasks');
  const visible = mode === 'agents' && selectedAgent ? events.filter((e) => e.taskId && agentTaskIds.has(e.taskId)) : mode === 'tasks' && selected ? events.filter((e) => e.taskId === selected) : events;

  const logRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [visible.length]);

  if (detail.loading && !detail.data) return <Spinner />;
  if (detail.error && !detail.data) return <ErrorNote message={detail.error.message} onRetry={() => void detail.reload()} />;
  if (!detail.data) return null;

  const { execution, tasks, approvals } = detail.data;
  const pending = approvals.filter((a) => a.status === 'pending');
  const finished = ['succeeded', 'failed', 'cancelled'].includes(execution.status);
  const used = execution.budgetUsd > 0 ? Math.min(100, (execution.costUsd / execution.budgetUsd) * 100) : 0;
  const done = tasks.filter((x) => x.status === 'done').length;

  async function decide(approvalId: string, decision: 'approved' | 'rejected') {
    setActionError(null);
    try {
      await api(`/approvals/${approvalId}/decide`, { method: 'POST', body: { decision } });
      void detail.reload(true);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t('err.generic'));
    }
  }

  async function cancel() {
    setActionError(null);
    try {
      await api(`/executions/${id}/cancel`, { method: 'POST' });
      setConfirmCancel(false);
      void detail.reload(true);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t('err.generic'));
    }
  }

  function describe(e: EventEnvelope): { text: string; tone: string; mono?: boolean } {
    const p = e.payload as Record<string, unknown>;
    const taskTitle = e.taskId ? (tasksById.get(e.taskId)?.title ?? '') : '';
    switch (e.type) {
      case 'log.appended':
        return { text: String(p.line ?? ''), tone: 'text-fg', mono: true };
      case 'task.state_changed':
        return { text: `${taskTitle}: ${t(`status.${String(p.to)}` as MessageKey)}`, tone: 'text-muted' };
      case 'execution.state_changed':
        return { text: `${t(`status.${String(p.to)}` as MessageKey)}${p.reason ? ` (${String(p.reason)})` : ''}`, tone: p.to === 'failed' ? 'text-fail' : 'text-muted' };
      case 'approval.requested':
        return { text: `${t('status.waiting_approval')}: ${String(p.title ?? taskTitle)}`, tone: 'text-wait' };
      case 'approval.decided':
        return { text: `${t(p.decision === 'approved' ? 'appr.approve' : 'appr.reject')}: ${taskTitle}`, tone: p.decision === 'approved' ? 'text-done' : 'text-fail' };
      case 'usage.updated':
        return {
          text: `${Number(p.inputTokens) + Number(p.outputTokens)} ${t('runs.tokens')} · ${p.costAvailable ? money(Number(p.costUsd)) : t('runs.costUnknown')}`,
          tone: 'text-muted',
        };
      case 'plan.updated':
        return { text: `Plano ampliado por ${taskTitle || String(p.by ?? '')}: ${((p.titles as string[] | undefined) ?? []).join('; ')}`, tone: 'text-wait' };
      case 'message.sent':
        return { text: `Mensagem de ${String(p.from ?? '')} para ${String(p.to ?? '')}: ${String(p.preview ?? '')}`, tone: 'text-fg', mono: true };
      case 'alert.raised':
        return { text: String(p.message ?? ''), tone: p.level === 'error' ? 'text-fail' : 'text-wait' };
      default:
        return { text: e.type, tone: 'text-muted' };
    }
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link to="/execucoes" className="text-sm text-muted hover:text-fg">
            {t('nav.runs')}
          </Link>
          <h1 className="mt-1 max-w-3xl text-xl font-semibold tracking-tight">{execution.goal}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
            <StatusBadge status={execution.status} />
            <span className="text-muted">
              <span className="font-mono">
                {done}/{tasks.length}
              </span>{' '}
              {t('runs.progress')}
            </span>
            <span className={cx('inline-flex items-center gap-1.5', connected ? 'text-done' : 'text-wait')}>
              <span aria-hidden className={cx('h-2 w-2 rounded-full', connected ? 'bg-done' : 'bg-wait')} />
              {connected ? t('runs.live') : t('runs.reconnecting')}
            </span>
          </div>
        </div>
        {!finished && execution.status !== 'draft' && (
          <div className="flex items-center gap-2">
            {confirmCancel ? (
              <>
                <span className="max-w-[260px] text-sm text-muted">{t('runs.cancelConfirm')}</span>
                <Button variant="danger" onClick={() => void cancel()}>
                  {t('common.confirm')}
                </Button>
                <Button variant="ghost" onClick={() => setConfirmCancel(false)}>
                  {t('common.cancel')}
                </Button>
              </>
            ) : (
              <Button variant="danger" onClick={() => setConfirmCancel(true)}>
                {t('runs.cancel')}
              </Button>
            )}
          </div>
        )}
      </div>

      {actionError && (
        <div className="mb-4">
          <ErrorNote message={actionError} />
        </div>
      )}

      {execution.failureReason && (
        <div className="mb-4 rounded-md border border-fail/60 bg-fail/10 px-3 py-2.5 text-sm text-fail">
          {t('runs.failureReason')}: <span className="font-mono">{execution.failureReason}</span>
        </div>
      )}

      {pending.map((a) => {
        const task = tasksById.get(a.taskId);
        return (
          <div key={a.id} className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-wait bg-wait/10 px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 font-medium">
                <StateIcon status="waiting_approval" />
                {task?.title}
              </div>
              <div className="text-sm text-muted">{t('runs.waitingDecision')}</div>
            </div>
            <div className="flex items-center gap-2">
              {task && <RiskBadge risk={task.risk} />}
              <Button variant="primary" onClick={() => void decide(a.id, 'approved')}>
                {t('appr.approve')}
              </Button>
              <Button variant="danger" onClick={() => void decide(a.id, 'rejected')}>
                {t('appr.reject')}
              </Button>
            </div>
          </div>
        );
      })}

      <div className="mb-6">
        <div className="mb-1.5 flex items-baseline justify-between text-sm">
          <span className="text-muted">{t('runs.budget')}</span>
          <span className="font-mono">
            {execution.costUnknown ? t('runs.costUnknown') : money(execution.costUsd)} / {money(execution.budgetUsd)}
          </span>
        </div>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(used)}
          aria-label={t('runs.budget')}
          className="h-1.5 overflow-hidden rounded-full bg-raised"
        >
          <div className={cx('h-full', used >= 80 ? 'bg-wait' : 'bg-run')} style={{ width: `${used}%` }} />
        </div>
      </div>

      <Section
        title={mode === 'agents' ? t('runs.agentsView') : t('runs.graph')}
        aside={
          <div role="group" aria-label={t('runs.graph')} className="inline-flex overflow-hidden rounded-md border border-line-strong text-sm">
            {(['agents', 'tasks'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={mode === v}
                onClick={() => setView(v)}
                className={cx('px-3 py-1', mode === v ? 'bg-raised font-medium text-fg' : 'text-muted hover:text-fg')}
              >
                {v === 'agents' ? t('runs.viewAgents') : t('runs.viewTasks')}
              </button>
            ))}
          </div>
        }
      >
        {mode === 'agents' ? (
          <HierarchyChart hierarchy={hierarchy} mode="execution" requestText={execution.goal} resultStatus={execution.status} selectedId={selectedAgent} onSelect={setSelectedAgent} />
        ) : (
          <ExecutionGraph tasks={tasks} selectedId={selected} onSelect={setSelected} />
        )}
      </Section>

      <Section
        title={t('runs.timeline')}
        aside={
          <span className="text-sm text-muted">
            {(mode === 'agents' ? selectedAgent : selected) ? (
              <>
                {mode === 'agents' ? t('runs.filterAgent') : t('runs.filtering')}{' '}
                <span className="text-fg">{mode === 'agents' ? (agentList.find((a) => a.id === selectedAgent)?.name ?? selectedAgent) : tasksById.get(selected!)?.title}</span>{' '}
                <button type="button" onClick={() => (mode === 'agents' ? setSelectedAgent(null) : setSelected(null))} className="underline hover:text-fg">
                  {t('runs.filterAll')}
                </button>
              </>
            ) : (
              t('runs.filterAll')
            )}
          </span>
        }
      >
        <ol
          ref={logRef}
          role="log"
          aria-live="polite"
          className="scroll-thin max-h-[420px] divide-y divide-line overflow-y-auto rounded-lg border border-line bg-surface"
        >
          {visible.length === 0 && <li className="px-4 py-6 text-center text-muted">{t('runs.noEvents')}</li>}
          {visible.map((e) => {
            const d = describe(e);
            return (
              <li key={e.seq} className="flex gap-3 px-4 py-2">
                <time dateTime={e.ts} className="shrink-0 font-mono text-xs text-faint">
                  {new Date(e.ts).toLocaleTimeString()}
                </time>
                <span className={cx('min-w-0 break-words', d.tone, d.mono && 'font-mono text-[13px]')}>{d.text}</span>
              </li>
            );
          })}
        </ol>
      </Section>
    </>
  );
}
