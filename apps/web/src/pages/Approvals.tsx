import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, cx, Empty, ErrorNote, inputCls, PageHeader, RiskBadge, Section, Spinner, StatusBadge } from '../components/ui';
import { api, ApiError, type Approval } from '../lib/api';
import { useHotkeys, useQuery } from '../lib/hooks';
import { useI18n } from '../lib/i18n';

export function Approvals() {
  const { t } = useI18n();
  const { data, error, loading, reload } = useQuery(() => api<{ items: Approval[] }>('/approvals'), [], 4000);
  const [index, setIndex] = useState(0);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pending = (data?.items ?? []).filter((a) => a.status === 'pending');
  const decided = (data?.items ?? []).filter((a) => a.status !== 'pending');
  const current = pending[Math.min(index, Math.max(0, pending.length - 1))];

  useEffect(() => {
    if (index > 0 && index >= pending.length) setIndex(Math.max(0, pending.length - 1));
  }, [pending.length, index]);

  async function decide(a: Approval, decision: 'approved' | 'rejected') {
    setBusy(true);
    setActionError(null);
    try {
      await api(`/approvals/${a.id}/decide`, { method: 'POST', body: { decision, reason: reason.trim() || undefined } });
      setRejecting(false);
      setReason('');
      await reload(true);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t('err.generic'));
    } finally {
      setBusy(false);
    }
  }

  useHotkeys(
    {
      j: () => setIndex((i) => Math.min(i + 1, pending.length - 1)),
      k: () => setIndex((i) => Math.max(i - 1, 0)),
      a: () => current && !busy && void decide(current, 'approved'),
      r: (e) => {
        if (!current) return;
        e.preventDefault();
        setRejecting(true);
      },
      escape: () => setRejecting(false),
    },
    true,
  );

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorNote message={error.message} onRetry={() => void reload()} />;

  return (
    <>
      <PageHeader title={t('appr.title')}>
        <span className="text-sm text-muted">{t('appr.keys')}</span>
      </PageHeader>

      {actionError && (
        <div className="mb-4">
          <ErrorNote message={actionError} />
        </div>
      )}

      {pending.length === 0 ? (
        <Empty>{t('appr.empty')}</Empty>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
          <ul aria-label={t('appr.pending')} className="divide-y divide-line self-start overflow-hidden rounded-lg border border-line bg-surface">
            {pending.map((a, i) => (
              <li key={a.id}>
                <button
                  type="button"
                  aria-current={current?.id === a.id}
                  onClick={() => {
                    setIndex(i);
                    setRejecting(false);
                  }}
                  className={cx('block w-full px-4 py-3 text-left hover:bg-raised', current?.id === a.id && 'bg-raised')}
                >
                  <span className="block font-medium">{a.kind === 'tool' && a.tool ? `${a.tool.name}: ${a.tool.summary}` : a.task?.title}</span>
                  {a.kind === 'tool' && <span className="block truncate text-xs text-muted">{a.task?.title}</span>}
                  <span className="mt-1 flex items-center gap-3 text-sm text-muted">
                    <StatusBadge status="waiting_approval" />
                    {a.kind === 'tool' && a.tool ? (
                      <span className={cx('text-xs font-medium', a.tool.risk === 'high' ? 'text-fail' : 'text-wait')}>{a.tool.risk === 'high' ? t('appr.toolHigh') : t('appr.toolMedium')}</span>
                    ) : (
                      a.task && <RiskBadge risk={a.task.risk} />
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {current && (
            <article className="rounded-lg border border-wait/70 bg-surface p-5">
              <h2 className="text-lg font-semibold">{current.task?.title}</h2>
              {current.kind === 'tool' && current.tool && (
                <div className="mt-4 rounded-md border border-line bg-raised p-4 text-sm">
                  <p className="text-muted">{t('appr.toolWhat')}</p>
                  <p className="mt-1 break-words font-medium">
                    <span className="mr-2 rounded bg-surface px-1.5 py-0.5 font-mono text-xs">{current.tool.name}</span>
                    {current.tool.summary}
                  </p>
                  {current.tool.argsPreview && (
                    <>
                      <p className="mt-3 text-muted">{t('appr.toolArgs')}</p>
                      <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-surface p-3 font-mono text-xs">{current.tool.argsPreview}</pre>
                    </>
                  )}
                  <p className="mt-3 text-xs text-muted">{t('appr.toolNote')}</p>
                </div>
              )}
              <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <dt className="text-muted">{t('appr.what')}</dt>
                  <dd className="mt-0.5">{current.goal}</dd>
                </div>
                <div>
                  <dt className="text-muted">{t('appr.agent')}</dt>
                  <dd className="mt-0.5">
                    {current.agent?.name} <span className="font-mono text-xs text-muted">{current.agent?.model}</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">{t('appr.project')}</dt>
                  <dd className="mt-0.5">
                    {current.project?.name}
                    <span className="block break-all font-mono text-xs text-muted">{current.project?.workspacePath}</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">{t('appr.risk')}</dt>
                  <dd className="mt-0.5">{current.task && <RiskBadge risk={current.task.risk} />}</dd>
                </div>
                {current.kind !== 'tool' && (
                  <div>
                    <dt className="text-muted">{t('appr.perms')}</dt>
                    <dd className="mt-0.5">{t('appr.permsValue')}</dd>
                  </div>
                )}
              </dl>

              <div className="mt-6 flex flex-wrap items-center gap-2">
                {!rejecting ? (
                  <>
                    <Button variant="primary" disabled={busy} onClick={() => void decide(current, 'approved')}>
                      {t('appr.approve')} <kbd className="font-mono text-xs opacity-60">A</kbd>
                    </Button>
                    <Button variant="danger" disabled={busy} onClick={() => setRejecting(true)}>
                      {t('appr.reject')} <kbd className="font-mono text-xs opacity-60">R</kbd>
                    </Button>
                    <Link to={`/execucoes/${current.executionId}`} className="ml-2 text-sm text-muted underline hover:text-fg">
                      {t('nav.runs')}
                    </Link>
                  </>
                ) : (
                  <div className="w-full space-y-3">
                    <p className="text-sm text-muted">{t('appr.rejectNote')}</p>
                    <input autoFocus className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('appr.reasonPh')} maxLength={500} />
                    <div className="flex gap-2">
                      <Button variant="danger" disabled={busy} onClick={() => void decide(current, 'rejected')}>
                        {t('appr.rejectConfirm')}
                      </Button>
                      <Button variant="ghost" onClick={() => setRejecting(false)}>
                        {t('common.cancel')}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </article>
          )}
        </div>
      )}

      {decided.length > 0 && (
        <div className="mt-10">
          <Section title={t('appr.history')}>
            <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
              {decided.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-4 px-4 py-3">
                  <span className="min-w-0 truncate">{a.kind === 'tool' && a.tool ? `${a.tool.name}: ${a.tool.summary}` : a.task?.title}</span>
                  <span className="flex items-center gap-3 text-sm">
                    {a.reason && <span className="max-w-[200px] truncate text-muted">{a.reason}</span>}
                    <StatusBadge status={a.status === 'approved' ? 'done' : 'failed'} />
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      )}
    </>
  );
}
