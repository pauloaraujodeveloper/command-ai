import { buildHierarchy } from '@command-ai/shared/hierarchy';
import { softwareTeam } from '@command-ai/shared/team';
import { Pencil, Trash2 } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { HierarchyChart } from '../components/HierarchyChart';
import { Button, Empty, ErrorNote, Field, inputCls, money, PageHeader, Section, Spinner } from '../components/ui';
import { api, ApiError, type Agent, type AgentTemplate } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useI18n } from '../lib/i18n';

type ScopeMode = 'any' | 'none' | 'list';
const blank = {
  name: '',
  role: '',
  instructions: '',
  providerKind: 'simulated',
  model: 'claude-sonnet-5-5',
  budgetUsd: '5',
  kind: 'specialist' as 'orchestrator' | 'specialist',
  domain: '',
  parentAgentId: '',
  responsibilities: '',
  scopeMode: 'any' as ScopeMode,
  scopeText: '',
  dependsOn: '',
};
type Form = typeof blank;

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
const commas = (s: string) => s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

function toForm(a: Agent): Form {
  return {
    name: a.name,
    role: a.role,
    instructions: (a as Agent & { instructions?: string }).instructions ?? '',
    providerKind: a.providerKind,
    model: a.model,
    budgetUsd: String(a.budgetUsd),
    kind: a.kind ?? 'specialist',
    domain: a.domain ?? '',
    parentAgentId: a.parentAgentId ?? '',
    responsibilities: a.responsibilities ?? '',
    scopeMode: a.writeScopes === undefined ? 'any' : a.writeScopes.length === 0 ? 'none' : 'list',
    scopeText: (a.writeScopes ?? []).join('\n'),
    dependsOn: (a.dependsOnDomains ?? []).join(', '),
  };
}

export function Agents() {
  const { t } = useI18n();
  const agents = useQuery(() => api<{ items: Agent[] }>('/agents'));
  const templates = useQuery(() => api<{ items: AgentTemplate[] }>('/agent-templates'));
  const [form, setForm] = useState<Form>(blank);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sw, setSw] = useState({ providerKind: 'simulated', model: 'claude-sonnet-5-5' });
  const [swBusy, setSwBusy] = useState(false);
  const [swDone, setSwDone] = useState(false);

  const list = agents.data?.items ?? [];
  const hierarchy = useMemo(() => buildHierarchy({ agents: list, withRequest: true, withResult: true }), [list]);
  const parents = list.filter((a) => a.kind === 'orchestrator' && a.id !== editing);

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function applyTemplate(id: string) {
    const tpl = templates.data?.items.find((x) => x.id === id);
    if (!tpl) return setForm(blank);
    setForm((f) => ({ ...f, name: tpl.name, role: tpl.role, instructions: tpl.instructions, model: tpl.model }));
  }

  function startEdit(a: Agent) {
    setEditing(a.id);
    setError(null);
    setForm(toForm(a));
    document.getElementById('agent-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function reset() {
    setEditing(null);
    setForm(blank);
    setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const scopes = form.scopeMode === 'any' ? undefined : form.scopeMode === 'none' ? [] : lines(form.scopeText);
      const base = {
        name: form.name,
        role: form.role,
        instructions: form.instructions,
        providerKind: form.providerKind,
        model: form.model,
        budgetUsd: Number(form.budgetUsd),
        kind: form.kind,
        dependsOnDomains: commas(form.dependsOn),
      };
      if (editing) {
        // null limpa o campo; os demais são enviados como estão
        await api(`/agents/${editing}`, {
          method: 'PATCH',
          body: {
            ...base,
            domain: form.domain.trim() ? form.domain.trim().toLowerCase() : null,
            parentAgentId: form.parentAgentId || null,
            responsibilities: form.responsibilities.trim() || null,
            writeScopes: scopes ?? null,
          },
        });
      } else {
        await api('/agents', {
          method: 'POST',
          body: {
            ...base,
            ...(form.domain.trim() ? { domain: form.domain.trim().toLowerCase() } : {}),
            ...(form.parentAgentId ? { parentAgentId: form.parentAgentId } : {}),
            ...(form.responsibilities.trim() ? { responsibilities: form.responsibilities.trim() } : {}),
            ...(scopes ? { writeScopes: scopes } : {}),
          },
          idempotent: true,
        });
      }
      reset();
      await agents.reload(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('err.generic'));
    } finally {
      setBusy(false);
    }
  }

  async function remove(a: Agent) {
    if (!window.confirm(t('agents.deleteConfirm'))) return;
    setError(null);
    try {
      await api(`/agents/${a.id}`, { method: 'DELETE' });
      if (editing === a.id) reset();
      await agents.reload(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('err.generic'));
    }
  }

  async function createSoftwareTeam() {
    setSwBusy(true);
    setError(null);
    setSwDone(false);
    try {
      const team = softwareTeam({ providerKind: sw.providerKind as 'simulated', model: sw.model, budgetUsd: 5 });
      const orq = await api<{ id: string }>('/agents', { method: 'POST', body: team.orchestrator, idempotent: true });
      for (const sp of team.specialists) await api('/agents', { method: 'POST', body: { ...sp, parentAgentId: orq.id }, idempotent: true });
      setSwDone(true);
      await agents.reload(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('err.generic'));
      await agents.reload(true);
    } finally {
      setSwBusy(false);
    }
  }

  const nameOf = (id?: string) => list.find((a) => a.id === id)?.name;

  return (
    <>
      <PageHeader title={t('team.title')} />

      <Section title={t('team.structure')}>
        {agents.loading && !agents.data && <Spinner />}
        {agents.data && list.length === 0 && <Empty>{t('team.empty')}</Empty>}
        {list.length > 0 && <HierarchyChart hierarchy={hierarchy} mode="team" />}
      </Section>

      <Section title={t('agents.softwareTeam')}>
        <div className="max-w-2xl space-y-3">
          <p className="text-sm text-muted">{t('agents.softwareTeamHint')}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('agents.softwareProvider')}>
              <select className={inputCls} value={sw.providerKind} onChange={(e) => setSw((x) => ({ ...x, providerKind: e.target.value }))}>
                <option value="simulated">simulated</option>
                <option value="anthropic">anthropic</option>
                <option value="openai">openai</option>
                <option value="deepseek">deepseek</option>
                <option value="claude_code">claude_code (assinatura)</option>
                <option value="codex">codex (assinatura)</option>
                <option value="ollama">ollama</option>
              </select>
            </Field>
            <Field label={t('agents.softwareModel')}>
              <input className={`${inputCls} font-mono`} value={sw.model} onChange={(e) => setSw((x) => ({ ...x, model: e.target.value }))} />
            </Field>
          </div>
          <div className="flex items-center gap-3">
            <Button type="button" disabled={swBusy || !sw.model.trim()} onClick={() => void createSoftwareTeam()}>
              {t('agents.softwareTeam')}
            </Button>
            {swDone && <span role="status" className="text-sm text-done">{t('agents.softwareTeamDone')}</span>}
          </div>
        </div>
      </Section>

      <Section title={t('agents.list')}>
        {agents.data && list.length === 0 && <Empty>{t('agents.empty')}</Empty>}
        {list.length > 0 && (
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
            {list.map((a) => (
              <li key={a.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{a.name}</span>
                    {a.kind === 'orchestrator' && <span className="rounded border border-wait/60 px-1.5 text-xs text-wait">{t('agents.orchestratorBadge')}</span>}
                    {a.domain && <span className="rounded border border-line-strong px-1.5 text-xs text-muted">{a.domain}</span>}
                  </div>
                  <div className="text-sm text-muted">{a.role}</div>
                  {a.parentAgentId && (
                    <div className="text-xs text-muted">
                      {t('agents.parent')}: {nameOf(a.parentAgentId) ?? '—'}
                    </div>
                  )}
                  <div className="mt-1 text-xs text-muted">
                    {a.writeScopes === undefined ? t('team.noRestriction') : a.writeScopes.length === 0 ? t('team.readOnly') : `${t('team.canWrite')}: ${a.writeScopes.join(', ')}`}
                    {a.dependsOnDomains && a.dependsOnDomains.length > 0 && ` · ${t('team.dependsOn')}: ${a.dependsOnDomains.join(', ')}`}
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="text-right text-sm">
                    <div className="font-mono">{a.model}</div>
                    <div className="text-muted">
                      {a.providerKind} · {money(a.budgetUsd)}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button type="button" onClick={() => startEdit(a)} aria-label={`${t('agents.edit')} ${a.name}`} title={t('agents.edit')} className="rounded p-1.5 text-muted hover:bg-raised hover:text-fg">
                      <Pencil size={16} aria-hidden />
                    </button>
                    <button type="button" onClick={() => void remove(a)} aria-label={`${t('agents.delete')} ${a.name}`} title={t('agents.delete')} className="rounded p-1.5 text-muted hover:bg-raised hover:text-fg">
                      <Trash2 size={16} aria-hidden />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={editing ? t('agents.editing') : t('agents.new')}>
        <form id="agent-form" onSubmit={submit} className="max-w-2xl space-y-4">
          {!editing && (
            <Field label={t('agents.fromTemplate')}>
              <select className={inputCls} defaultValue="" onChange={(e) => applyTemplate(e.target.value)}>
                <option value="">{t('agents.noTemplate')}</option>
                {templates.data?.items.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('agents.name')}>
              <input required className={inputCls} value={form.name} onChange={set('name')} maxLength={80} />
            </Field>
            <Field label={t('agents.role')}>
              <input required className={inputCls} value={form.role} onChange={set('role')} maxLength={120} />
            </Field>
          </div>
          <Field label={t('agents.instructions')}>
            <textarea required rows={4} className={inputCls} value={form.instructions} onChange={set('instructions')} maxLength={8000} />
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t('agents.kind')}>
              <select className={inputCls} value={form.kind} onChange={set('kind')}>
                <option value="specialist">{t('team.kind.specialist')}</option>
                <option value="orchestrator">{t('team.kind.orchestrator')}</option>
              </select>
            </Field>
            <Field label={t('agents.domain')}>
              <input className={inputCls} value={form.domain} onChange={set('domain')} maxLength={40} placeholder="frontend" />
            </Field>
            <Field label={t('agents.parent')}>
              <select className={inputCls} value={form.parentAgentId} onChange={set('parentAgentId')}>
                <option value="">{t('agents.noParent')}</option>
                {parents.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label={t('agents.responsibilities')}>
            <textarea rows={3} className={inputCls} value={form.responsibilities} onChange={set('responsibilities')} maxLength={2000} />
          </Field>
          <Field label={t('agents.scope')}>
            <select className={inputCls} value={form.scopeMode} onChange={set('scopeMode')}>
              <option value="any">{t('agents.scopeAny')}</option>
              <option value="none">{t('agents.scopeNone')}</option>
              <option value="list">{t('agents.scopeList')}</option>
            </select>
          </Field>
          {form.scopeMode === 'list' && (
            <Field label={t('agents.scopeList')}>
              <textarea rows={4} className={`${inputCls} font-mono`} value={form.scopeText} onChange={set('scopeText')} placeholder={'apps/web/**\nweb/**'} />
              <p className="mt-1 text-xs text-muted">{t('agents.scopeHint')}</p>
            </Field>
          )}
          <Field label={t('agents.dependsOn')}>
            <input className={inputCls} value={form.dependsOn} onChange={set('dependsOn')} placeholder="backend, database" />
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t('agents.provider')}>
              <select className={inputCls} value={form.providerKind} onChange={set('providerKind')}>
                <option value="simulated">simulated</option>
                <option value="anthropic">anthropic</option>
                <option value="openai">openai</option>
                <option value="deepseek">deepseek</option>
                <option value="claude_code">claude_code (assinatura)</option>
                <option value="codex">codex (assinatura)</option>
                <option value="ollama">ollama</option>
              </select>
            </Field>
            <Field label={t('agents.model')}>
              <input required className={`${inputCls} font-mono`} value={form.model} onChange={set('model')} />
            </Field>
            <Field label={t('agents.budget')}>
              <input required type="number" min="0.01" step="0.01" className={inputCls} value={form.budgetUsd} onChange={set('budgetUsd')} />
            </Field>
          </div>
          {error && <ErrorNote message={error} />}
          <div className="flex gap-3">
            <Button type="submit" variant="primary" disabled={busy}>
              {editing ? t('agents.saveChanges') : t('common.create')}
            </Button>
            {editing && (
              <Button type="button" onClick={reset}>
                {t('agents.cancelEdit')}
              </Button>
            )}
          </div>
        </form>
      </Section>
    </>
  );
}
