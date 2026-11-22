import { AlertTriangle, CircleCheck, Hourglass, WifiOff, Wallet, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Empty, ErrorNote, money, PageHeader, Section, Spinner, StatusBadge } from '../components/ui';
import { api, type Dashboard } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useI18n } from '../lib/i18n';

const ICON: Record<Dashboard['attention'][number]['kind'], { Icon: LucideIcon; color: string }> = {
  approval: { Icon: Hourglass, color: 'text-wait' },
  failure: { Icon: AlertTriangle, color: 'text-fail' },
  budget: { Icon: Wallet, color: 'text-wait' },
  runner_offline: { Icon: WifiOff, color: 'text-queue' },
};

export function Home() {
  const { t } = useI18n();
  const { data, error, loading, reload } = useQuery(() => api<Dashboard>('/dashboard'), [], 5000);

  if (loading && !data) return <Spinner />;
  if (error && !data) return <ErrorNote message={error.message} onRetry={() => void reload()} />;
  if (!data) return null;

  const numbers: Array<[string, string]> = [
    [t('home.running'), String(data.numbers.running)],
    [t('home.ok24'), String(data.numbers.succeeded24h)],
    [t('home.fail24'), String(data.numbers.failed24h)],
    [t('home.cost24'), money(data.numbers.costUsd24h)],
  ];

  return (
    <>
      <PageHeader title={t('nav.home')} />

      <Section title={t('home.attention')}>
        {data.attention.length === 0 ? (
          <div className="flex items-center gap-2 rounded-md border border-line bg-surface px-4 py-3 text-muted">
            <CircleCheck size={17} className="text-done" aria-hidden />
            {t('home.allClear')}
          </div>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
            {data.attention.map((a, i) => {
              const { Icon, color } = ICON[a.kind];
              return (
                <li key={`${a.kind}-${i}`}>
                  <Link to={a.to} className="flex items-start gap-3 px-4 py-3 hover:bg-raised">
                    <Icon size={18} className={`mt-0.5 shrink-0 ${color}`} aria-hidden />
                    <span className="min-w-0">
                      <span className="block font-medium">{a.title}</span>
                      <span className="block text-sm text-muted">{a.detail}</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title={t('home.recent')}>
        <dl className="mb-5 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          {numbers.map(([label, value]) => (
            <div key={label}>
              <dt className="text-sm text-muted">{label}</dt>
              <dd className="font-mono text-xl font-medium">{value}</dd>
            </div>
          ))}
        </dl>

        {data.recent.length === 0 ? (
          <Empty
            action={
              <Link to="/nova" className="inline-flex rounded-md bg-inv-bg px-3.5 py-2 text-sm font-medium text-inv-fg">
                {t('home.createFirst')}
              </Link>
            }
          >
            {t('home.noRuns')}
          </Empty>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
            {data.recent.map((e) => (
              <li key={e.id}>
                <Link to={`/execucoes/${e.id}`} className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-raised">
                  <span className="truncate">{e.goal}</span>
                  <StatusBadge status={e.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
