import { Link } from 'react-router-dom';
import { Empty, ErrorNote, money, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { api, type Execution } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useI18n } from '../lib/i18n';

export function Executions() {
  const { t } = useI18n();
  const { data, error, loading, reload } = useQuery(() => api<{ items: Execution[] }>('/executions'), [], 5000);

  return (
    <>
      <PageHeader title={t('runs.title')}>
        <Link to="/nova" className="rounded-md bg-inv-bg px-3.5 py-2 text-sm font-medium text-inv-fg">
          {t('nav.new')}
        </Link>
      </PageHeader>
      {loading && !data && <Spinner />}
      {error && !data && <ErrorNote message={error.message} onRetry={() => void reload()} />}
      {data && data.items.length === 0 && <Empty>{t('runs.empty')}</Empty>}
      {data && data.items.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="border-b border-line text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">{t('new.goal')}</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">{t('runs.progress')}</th>
                <th className="px-4 py-2.5 text-right font-medium">{t('runs.budget')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.items.map((e) => (
                <tr key={e.id} className="hover:bg-raised">
                  <td className="max-w-[360px] truncate px-4 py-3">
                    <Link to={`/execucoes/${e.id}`} className="font-medium hover:underline">
                      {e.goal}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={e.status} />
                  </td>
                  <td className="px-4 py-3 font-mono">
                    {e.progress?.done ?? 0}/{e.progress?.total ?? 0}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {money(e.costUsd)} / {money(e.budgetUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
