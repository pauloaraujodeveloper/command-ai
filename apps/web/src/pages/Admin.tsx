import { MfaSetup } from '../components/MfaSetup';
import { ErrorNote, PageHeader, Section, Spinner } from '../components/ui';
import { api, type AuditEntry } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useI18n } from '../lib/i18n';

export function Admin() {
  const { t } = useI18n();
  const audit = useQuery(() => api<{ items: AuditEntry[] }>('/audit'));

  return (
    <>
      <PageHeader title={t('admin.title')} />

      <Section title={t('admin.mfa')}>
        <MfaSetup />
      </Section>

      <Section title={t('admin.audit')}>
        {audit.loading && !audit.data && <Spinner />}
        {audit.error && !audit.data && <ErrorNote message={audit.error.message} />}
        {audit.data && audit.data.items.length === 0 && <p className="text-muted">{t('admin.auditEmpty')}</p>}
        {audit.data && audit.data.items.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="border-b border-line text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">{t('admin.when')}</th>
                  <th className="px-4 py-2.5 font-medium">{t('admin.action')}</th>
                  <th className="px-4 py-2.5 font-medium">{t('admin.target')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {audit.data.items.slice(0, 100).map((a) => (
                  <tr key={a.id}>
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">{new Date(a.at).toLocaleString()}</td>
                    <td className="px-4 py-2 font-mono text-xs">{a.action}</td>
                    <td className="max-w-[260px] truncate px-4 py-2 font-mono text-xs text-muted">{a.target}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}
