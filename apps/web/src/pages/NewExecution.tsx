import { Plus, Trash2 } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { costFor } from '@command-ai/shared';
import { Button, Empty, ErrorNote, Field, inputCls, money, PageHeader, RiskBadge, Section, Spinner } from '../components/ui';
import { api, ApiError, type Agent, type Execution, type Project, type RiskLevel, type Task } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useI18n, type MessageKey } from '../lib/i18n';

interface PlanRow {
  id: string;
  title: string;
  agentId: string;
  dependsOn: string[];
  risk: RiskLevel;
}

const TOKENS_IN_PER_TASK = 6000;
const TOKENS_OUT_PER_TASK = 3000;
const SECONDS_PER_TASK = 45;

/** Número de tarefas no caminho mais longo, para estimar o tempo com paralelismo. */
function criticalPath(plan: PlanRow[]): number {
  const byId = new Map(plan.map((p) => [p.id, p]));
  const memo = new Map<string, number>();
  const seen = new Set<string>();
  const depth = (id: string): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (seen.has(id)) return 1; // ciclo: o servidor rejeita; aqui só evitamos recursão infinita
    seen.add(id);
    const row = byId.get(id);
    const parents = (row?.dependsOn ?? []).filter((d) => byId.has(d));
    const d = 1 + (parents.length ? Math.max(...parents.map(depth)) : 0);
    memo.set(id, d);
    return d;
  };
  return plan.length ? Math.max(...plan.map((p) => depth(p.id))) : 0;
}

export function NewExecution() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const agents = useQuery(() => api<{ items: Agent[] }>('/agents'));
  const projects = useQuery(() => api<{ items: Project[] }>('/projects'));

  const [goal, setGoal] = useState('');
  const [projectId, setProjectId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [budget, setBudget] = useState('');
  const [execId, setExecId] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const agentList = agents.data?.items ?? [];
  const projectList = projects.data?.items ?? [];
  const agent = agentList.find((a) => a.id === (agentId || agentList[0]?.id));

  const estimate = useMemo(() => {
    const cost = agent ? costFor(agent.model, { inputTokens: plan.length * TOKENS_IN_PER_TASK, outputTokens: plan.length * TOKENS_OUT_PER_TASK }) : null;
    const minutes = Math.max(1, Math.round((criticalPath(plan) * SECONDS_PER_TASK) / 60));
    return { cost, minutes };
  }, [plan, agent]);

  if (agents.loading || projects.loading) return <Spinner />;
  if (agentList.length === 0 || projectList.length === 0) {
    return (
      <>
        <PageHeader title={t('new.title')} />
        <Empty
          action={
            <div className="flex justify-center gap-2">
              <Link to="/agentes" className="rounded-md border border-line-strong px-3 py-2 text-sm hover:bg-raised">
                {t('new.goAgents')}
              </Link>
              <Link to="/projetos" className="rounded-md border border-line-strong px-3 py-2 text-sm hover:bg-raised">
                {t('new.goProjects')}
              </Link>
            </div>
          }
        >
          {t('new.needSetup')}
        </Empty>
      </>
    );
  }

  const selectedAgent = agentId || agentList[0]!.id;
  const selectedProject = projectId || projectList[0]!.id;

  async function generate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { goal, projectId: selectedProject, agentId: selectedAgent };
      if (budget) body.budgetUsd = Number(budget);
      const res = await api<{ execution: Execution; tasks: Task[] }>('/executions', { method: 'POST', body, idempotent: true });
      setExecId(res.execution.id);
      setPlan(res.tasks.map((x) => ({ id: x.planId, title: x.title, agentId: x.agentId, dependsOn: x.dependsOn.map((d) => d.split(':').pop() ?? d), risk: x.risk })));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('err.generic'));
    } finally {
      setBusy(false);
    }
  }

  const updateRow = (id: string, patch: Partial<PlanRow>) => setPlan((p) => p.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const removeRow = (id: string) => setPlan((p) => p.filter((r) => r.id !== id).map((r) => ({ ...r, dependsOn: r.dependsOn.filter((d) => d !== id) })));
  const addRow = () =>
    setPlan((p) => [...p, { id: `t${Date.now().toString(36)}`, title: '', agentId: selectedAgent, dependsOn: [], risk: 'low' }]);
  const toggleDep = (row: PlanRow, dep: string) =>
    updateRow(row.id, { dependsOn: row.dependsOn.includes(dep) ? row.dependsOn.filter((d) => d !== dep) : [...row.dependsOn, dep] });

  async function start() {
    if (!execId) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/executions/${execId}/plan`, { method: 'PATCH', body: { tasks: plan } });
      await api(`/executions/${execId}/start`, { method: 'POST' });
      navigate(`/execucoes/${execId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('err.generic'));
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title={t('new.title')} />

      <form onSubmit={generate} className="mb-8 space-y-4">
        <Field label={t('new.goal')}>
          <textarea
            required
            minLength={5}
            rows={3}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder={t('new.goalPh')}
            disabled={!!execId}
            className={inputCls}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t('new.project')}>
            <select className={inputCls} value={selectedProject} onChange={(e) => setProjectId(e.target.value)} disabled={!!execId}>
              {projectList.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('new.agent')}>
            <select className={inputCls} value={selectedAgent} onChange={(e) => setAgentId(e.target.value)} disabled={!!execId}>
              {agentList.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.model}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('new.budget')}>
            <input type="number" min="0.01" step="0.01" className={inputCls} value={budget} placeholder={String(agent?.budgetUsd ?? 5)} onChange={(e) => setBudget(e.target.value)} disabled={!!execId} />
          </Field>
        </div>
        {!execId && (
          <Button type="submit" variant="primary" disabled={busy}>
            {t('new.plan')}
          </Button>
        )}
      </form>

      {error && (
        <div className="mb-4">
          <ErrorNote message={error} />
        </div>
      )}

      {execId && (
        <Section title={t('new.planTitle')} aside={<span className="text-sm text-muted">{t('new.planHint')}</span>}>
          <ul className="space-y-3">
            {plan.map((row) => (
              <li key={row.id} className="rounded-lg border border-line bg-surface p-4">
                <div className="grid gap-3 md:grid-cols-[1fr_200px_140px_auto]">
                  <Field label={t('new.taskTitle')}>
                    <input className={inputCls} value={row.title} onChange={(e) => updateRow(row.id, { title: e.target.value })} />
                  </Field>
                  <Field label={t('new.agent')}>
                    <select className={inputCls} value={row.agentId} onChange={(e) => updateRow(row.id, { agentId: e.target.value })}>
                      {agentList.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('new.risk')}>
                    <select className={inputCls} value={row.risk} onChange={(e) => updateRow(row.id, { risk: e.target.value as RiskLevel })}>
                      {(['low', 'medium', 'high'] as const).map((r) => (
                        <option key={r} value={r}>
                          {t(`risk.${r}` as MessageKey)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className="flex items-end">
                    <Button variant="ghost" onClick={() => removeRow(row.id)} aria-label={`${t('common.remove')}: ${row.title}`} disabled={plan.length === 1}>
                      <Trash2 size={16} aria-hidden />
                    </Button>
                  </div>
                </div>
                <fieldset className="mt-3">
                  <legend className="mb-1 text-sm text-muted">{t('new.dependsOn')}</legend>
                  {plan.filter((o) => o.id !== row.id).length === 0 ? (
                    <span className="text-sm text-faint">{t('new.noDeps')}</span>
                  ) : (
                    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                      {plan
                        .filter((o) => o.id !== row.id)
                        .map((o) => (
                          <label key={o.id} className="flex items-center gap-1.5 text-sm">
                            <input type="checkbox" checked={row.dependsOn.includes(o.id)} onChange={() => toggleDep(row, o.id)} />
                            <span className="max-w-[220px] truncate">{o.title || o.id}</span>
                          </label>
                        ))}
                    </div>
                  )}
                </fieldset>
                {row.risk === 'high' && (
                  <p className="mt-3 flex items-center gap-2 text-sm text-fail">
                    <RiskBadge risk="high" />
                    {t('new.highRiskNote')}
                  </p>
                )}
              </li>
            ))}
          </ul>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
            <Button onClick={addRow}>
              <Plus size={16} aria-hidden />
              {t('new.addTask')}
            </Button>
            <div className="text-right text-sm" aria-live="polite">
              <div>
                <span className="text-muted">{t('new.estCost')}: </span>
                <span className="font-mono">{estimate.cost === null ? t('new.unavailable') : money(estimate.cost)}</span>
                <span className="text-muted"> · {t('new.estTime')}: </span>
                <span className="font-mono">≈ {estimate.minutes} min</span>
              </div>
              <div className="text-xs text-faint">{t('new.estNote')}</div>
            </div>
          </div>

          <div className="mt-6">
            <Button variant="primary" onClick={() => void start()} disabled={busy || plan.some((r) => !r.title.trim())}>
              {t('new.start')}
            </Button>
          </div>
        </Section>
      )}
    </>
  );
}
