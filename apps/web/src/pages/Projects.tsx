import { useState, type FormEvent } from 'react';
import { Button, Empty, ErrorNote, Field, inputCls, PageHeader, Section, Spinner } from '../components/ui';
import { api, ApiError, type Project } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useI18n } from '../lib/i18n';

const MAX_CONTEXT = 100_000;

function ContextEditor({ project, onSaved }: { project: Project; onSaved: () => Promise<void> }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(project.context ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const size = (project.context ?? '').length;

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api(`/projects/${project.id}`, { method: 'PATCH', body: { context: text } });
      await onSaved();
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('err.generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
        <span>
          {t('projects.context')}: {size > 0 ? `${size.toLocaleString()} ${t('projects.contextChars')}` : t('projects.contextNone')}
        </span>
        <button type="button" className="text-fg underline underline-offset-2" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {t('projects.contextEdit')}
        </button>
      </div>
      {open && (
        <div className="mt-2 space-y-2">
          <textarea
            aria-label={t('projects.context')}
            rows={12}
            className={`${inputCls} font-mono text-sm`}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSaved(false);
            }}
            maxLength={MAX_CONTEXT}
          />
          <p className="text-xs text-muted">
            {t('projects.contextHint')} {text.length.toLocaleString()} / {MAX_CONTEXT.toLocaleString()} {t('projects.contextChars')}
          </p>
          {error && <ErrorNote message={error} />}
          <div className="flex items-center gap-3">
            <Button type="button" variant="primary" disabled={busy} onClick={() => void save()}>
              {t('projects.contextSave')}
            </Button>
            {saved && <span role="status" className="text-sm text-done">{t('projects.contextSaved')}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/** Ponte do app desktop (preload): abre o seletor de pastas do sistema. Fora do desktop não existe. */
interface DesktopBridge {
  pickFolder: () => Promise<string | null>;
}
const desktop = (): DesktopBridge | undefined => (window as unknown as { commandAIDesktop?: DesktopBridge }).commandAIDesktop;

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
                <ContextEditor project={p} onSaved={() => projects.reload(true)} />
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
            <div className="flex gap-2">
              <input required className={`${inputCls} font-mono`} value={workspacePath} onChange={(e) => setWorkspacePath(e.target.value)} maxLength={500} />
              {desktop() && (
                <Button
                  type="button"
                  onClick={async () => {
                    const picked = await desktop()?.pickFolder();
                    if (picked) setWorkspacePath(picked);
                  }}
                  className="shrink-0"
                >
                  {t('projects.pick')}
                </Button>
              )}
            </div>
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
