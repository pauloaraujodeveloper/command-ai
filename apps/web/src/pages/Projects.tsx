import { useState, type FormEvent } from 'react';
import { Button, Empty, ErrorNote, Field, inputCls, PageHeader, Section, Spinner } from '../components/ui';
import { api, ApiError, type Project } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useI18n } from '../lib/i18n';

export function Projects() {
  const { t } = useI18n();
  const projects = useQuery(() => api<{ items: Project[] }>('/projects'));
  const [name, setName] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/projects', { method: 'POST', body: { name, workspacePath }, idempotent: true });
      setName('');
      setWorkspacePath('');
      await projects.reload(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('err.generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title={t('projects.title')} />
      <Section title={t('projects.title')}>
        {projects.loading && !projects.data && <Spinner />}
        {projects.data && projects.data.items.length === 0 && <Empty>{t('projects.empty')}</Empty>}
        {projects.data && projects.data.items.length > 0 && (
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
            {projects.data.items.map((p) => (
              <li key={p.id} className="px-4 py-3">
                <div className="font-medium">{p.name}</div>
                <div className="break-all font-mono text-sm text-muted">{p.workspacePath}</div>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title={t('projects.new')}>
        <form onSubmit={submit} className="max-w-xl space-y-4">
          <Field label={t('projects.name')}>
            <input required className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </Field>
          <Field label={t('projects.path')} hint={t('projects.pathHint')}>
            <input required className={`${inputCls} font-mono`} value={workspacePath} onChange={(e) => setWorkspacePath(e.target.value)} maxLength={500} />
          </Field>
          {error && <ErrorNote message={error} />}
          <Button type="submit" variant="primary" disabled={busy}>
            {t('common.create')}
          </Button>
        </form>
      </Section>
    </>
  );
}
