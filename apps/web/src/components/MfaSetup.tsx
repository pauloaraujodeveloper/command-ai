import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { Button, ErrorNote, Field, inputCls } from './ui';

/** Ativação do MFA por aplicativo autenticador. Usada na Administração e na tela de MFA obrigatório. */
export function MfaSetup() {
  const { t } = useI18n();
  const { me, refresh } = useAuth();
  const [secret, setSecret] = useState<string | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function enroll() {
    setError(null);
    try {
      const res = await api<{ secret: string; otpauthUri: string }>('/auth/mfa/enroll', { method: 'POST' });
      setSecret(res.secret);
      setUri(res.otpauthUri);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('err.generic'));
    }
  }

  async function activate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/auth/mfa/activate', { method: 'POST', body: { code } });
      setSecret(null);
      setUri(null);
      setCode('');
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('err.generic'));
    }
  }

  if (me?.user.mfaEnabled) return <p className="text-done">{t('admin.mfaOn')}</p>;

  return (
    <div className="max-w-md">
      {secret ? (
        <form onSubmit={activate} className="space-y-4">
          <div>
            <div className="mb-1 text-sm text-muted">{t('admin.mfaSecret')}</div>
            <code className="block break-all rounded bg-surface px-3 py-2 font-mono text-sm">{secret}</code>
            {uri && <code className="mt-2 block break-all text-xs text-faint">{uri}</code>}
          </div>
          <Field label={t('admin.mfaCode')}>
            <input
              required
              autoFocus
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              className={`${inputCls} font-mono tracking-widest`}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
            />
          </Field>
          <Button type="submit" variant="primary">
            {t('admin.mfaActivate')}
          </Button>
        </form>
      ) : (
        <Button variant="primary" onClick={() => void enroll()}>
          {t('admin.mfaEnroll')}
        </Button>
      )}
      {error && (
        <div className="mt-3">
          <ErrorNote message={error} />
        </div>
      )}
    </div>
  );
}
