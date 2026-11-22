import { Check, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button, cx, Empty, ErrorNote, Field, inputCls, PageHeader, Section, Spinner } from '../components/ui';
import { api, ApiError, type Provider, type RunnerRow } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useI18n } from '../lib/i18n';

export function Integrations() {
  const { t } = useI18n();
  const providers = useQuery(() => api<{ items: Provider[] }>('/providers'));
  const runners = useQuery(() => api<{ items: RunnerRow[] }>('/runners'), [], 5000);

  const [pf, setPf] = useState({ kind: 'simulated', name: '', apiKeyRef: '', defaultModel: 'claude-sonnet-5-5' });
  const [pError, setPError] = useState<string | null>(null);
  const [testNote, setTestNote] = useState<Record<string, string>>({});

  const [runnerName, setRunnerName] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [rError, setRError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function addProvider(e: FormEvent) {
    e.preventDefault();
    setPError(null);
    try {
      await api('/providers', { method: 'POST', body: { ...pf, apiKeyRef: pf.apiKeyRef || undefined } });
      setPf({ kind: 'simulated', name: '', apiKeyRef: '', defaultModel: 'claude-sonnet-5-5' });
      await providers.reload(true);
    } catch (err) {
      setPError(err instanceof ApiError ? err.message : t('err.generic'));
    }
  }

  async function testProvider(id: string) {
    try {
      const res = await api<{ note: string }>(`/providers/${id}/test`, { method: 'POST' });
      setTestNote((n) => ({ ...n, [id]: res.note }));
    } catch (err) {
      setTestNote((n) => ({ ...n, [id]: err instanceof ApiError ? err.message : t('err.generic') }));
    }
  }

  async function addRunner(e: FormEvent) {
    e.preventDefault();
    setRError(null);
    try {
      const res = await api<{ token: string }>('/runners', { method: 'POST', body: { name: runnerName } });
      setToken(res.token);
      setRunnerName('');
      await runners.reload(true);
    } catch (err) {
      setRError(err instanceof ApiError ? err.message : t('err.generic'));
    }
  }

  async function revoke(id: string) {
    await api(`/runners/${id}`, { method: 'DELETE' });
    await runners.reload(true);
  }

  async function copy() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      /* o usuário pode selecionar manualmente */
    }
  }

  return (
    <>
      <PageHeader title={t('integ.title')} />

      <Section title={t('integ.runners')}>
        {runners.loading && !runners.data && <Spinner />}
        {runners.data && runners.data.items.length === 0 && <Empty>{t('integ.noRunner')}</Empty>}
        {runners.data && runners.data.items.length > 0 && (
          <ul className="mb-4 divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
            {runners.data.items.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="font-medium">{r.name}</span>
                <span className="flex items-center gap-3 text-sm">
                  <span className={cx('inline-flex items-center gap-1.5', r.revoked ? 'text-fail' : r.online ? 'text-done' : 'text-queue')}>
                    {r.revoked ? <X size={14} aria-hidden /> : r.online ? <Check size={14} aria-hidden /> : <span aria-hidden className="h-2 w-2 rounded-full border border-current" />}
                    {r.revoked ? t('integ.revoked') : r.online ? t('integ.online') : t('integ.offline')}
                  </span>
                  {!r.revoked && (
                    <Button variant="ghost" onClick={() => void revoke(r.id)} className="!py-1">
                      {t('integ.revoke')}
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        {token && (
          <div className="mb-4 rounded-md border border-wait/70 bg-wait/10 p-4">
            <div className="mb-1 text-sm font-medium">{t('integ.token')}</div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded bg-bg px-2 py-1.5 font-mono text-xs">{token}</code>
              <Button onClick={() => void copy()}>{copied ? t('common.copied') : t('common.copy')}</Button>
            </div>
            <p className="mt-3 text-sm text-muted">{t('integ.runCmd')}</p>
            <pre className="mt-1 overflow-x-auto rounded bg-bg p-3 font-mono text-xs">{`$env:COMMAND_AI_RUNNER_TOKEN="${token}"\n$env:RUNNER_ALLOWED_WORKSPACES="C:\\caminho\\do\\projeto"\npnpm --filter @command-ai/runner start`}</pre>
          </div>
        )}

        <form onSubmit={addRunner} className="flex max-w-xl items-end gap-3">
          <div className="flex-1">
            <Field label={t('integ.runnerName')}>
              <input required className={inputCls} value={runnerName} onChange={(e) => setRunnerName(e.target.value)} maxLength={80} />
            </Field>
          </div>
          <Button type="submit" variant="primary">
            {t('integ.runnerAdd')}
          </Button>
        </form>
        {rError && (
          <div className="mt-3">
            <ErrorNote message={rError} />
          </div>
        )}
      </Section>

      <Section title={t('integ.providers')}>
        {providers.loading && !providers.data && <Spinner />}
        {providers.data && providers.data.items.length === 0 && <Empty>{t('integ.noProviders')}</Empty>}
        {providers.data && providers.data.items.length > 0 && (
          <ul className="mb-4 divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
            {providers.data.items.map((p) => (
              <li key={p.id} className="px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <span className="font-medium">{p.name}</span>{' '}
                    <span className="font-mono text-sm text-muted">
                      {p.kind} · {p.defaultModel}
                    </span>
                  </div>
                  <Button variant="ghost" onClick={() => void testProvider(p.id)} className="!py-1">
                    {t('integ.test')}
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5" aria-label={t('integ.caps')}>
                  {Object.entries(p.capabilities).map(([k, v]) => (
                    <span key={k} className={cx('inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs', v ? 'border-line-strong text-fg' : 'border-line text-faint line-through')}>
                      {v ? <Check size={11} aria-hidden /> : <X size={11} aria-hidden />}
                      {k}
                    </span>
                  ))}
                </div>
                {testNote[p.id] && <p className="mt-2 text-sm text-muted">{testNote[p.id]}</p>}
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={addProvider} className="max-w-2xl space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('integ.kind')}>
              <select className={inputCls} value={pf.kind} onChange={(e) => setPf({ ...pf, kind: e.target.value })}>
                <option value="simulated">simulated</option>
                <option value="anthropic">anthropic</option>
                <option value="openai">openai</option>
                <option value="ollama">ollama</option>
              </select>
            </Field>
            <Field label={t('integ.name')}>
              <input required className={inputCls} value={pf.name} onChange={(e) => setPf({ ...pf, name: e.target.value })} maxLength={80} />
            </Field>
            <Field label={t('integ.keyRef')} hint={t('integ.keyRefHint')}>
              <input className={`${inputCls} font-mono`} placeholder="ANTHROPIC_API_KEY" value={pf.apiKeyRef} onChange={(e) => setPf({ ...pf, apiKeyRef: e.target.value.toUpperCase() })} pattern="[A-Z][A-Z0-9_]{1,63}" />
            </Field>
            <Field label={t('integ.model')}>
              <input required className={`${inputCls} font-mono`} value={pf.defaultModel} onChange={(e) => setPf({ ...pf, defaultModel: e.target.value })} />
            </Field>
          </div>
          {pError && <ErrorNote message={pError} />}
          <Button type="submit" variant="primary">
            {t('integ.providerAdd')}
          </Button>
        </form>
      </Section>
    </>
  );
}
