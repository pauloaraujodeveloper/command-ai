import { useState, type FormEvent } from 'react';
import { Button, Empty, ErrorNote, Field, inputCls, money, PageHeader, Section, Spinner } from '../components/ui';
import { api, ApiError, type Agent, type AgentTemplate } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useI18n } from '../lib/i18n';

const blank = { name: '', role: '', instructions: '', providerKind: 'simulated', model: 'claude-sonnet-5-5', budgetUsd: '5' };

export function Agents() {
  const { t } = useI18n();
  const agents = useQuery(() => api<{ items: Agent[] }>('/agents'));
  const templates = useQuery(() => api<{ items: AgentTemplate[] }>('/agent-templates'));
  const [form, setForm] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof blank) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function applyTemplate(id: string) {
    const tpl = templates.data?.items.find((x) => x.id === id);
    if (!tpl) return setForm(blank);
    setForm((f) => ({ ...f, name: tpl.name, role: tpl.role, instructions: tpl.instructions, model: tpl.model }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/agents', { method: 'POST', body: { ...form, budgetUsd: Number(form.budgetUsd) } });
      setForm(blank);
      await agents.reload(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('err.generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title={t('agents.title')} />

      <Section title={t('agents.title')}>
        {agents.loading && !agents.data && <Spinner />}
        {agents.data && agents.data.items.length === 0 && <Empty>{t('agents.empty')}</Empty>}
        {agents.data && agents.data.items.length > 0 && (
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
            {agents.data.items.map((a) => (
              <li key={a.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="font-medium">{a.name}</div>
                  <div className="text-sm text-muted">{a.role}</div>
                </div>
                <div className="text-right text-sm">
                  <div className="font-mono">{a.model}</div>
                  <div className="text-muted">
                    {a.providerKind} · {money(a.budgetUsd)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t('agents.new')}>
        <form onSubmit={submit} className="max-w-2xl space-y-4">
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
            <Field label={t('agents.provider')}>
              <select className={inputCls} value={form.providerKind} onChange={set('providerKind')}>
                <option value="simulated">simulated</option>
                <option value="anthropic">anthropic</option>
                <option value="openai">openai</option>
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
          <Button type="submit" variant="primary" disabled={busy}>
            {t('common.create')}
          </Button>
        </form>
      </Section>
    </>
  );
}
