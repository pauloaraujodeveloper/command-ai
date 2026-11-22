import { useState, type FormEvent } from 'react';
import { Logo } from '../components/Logo';
import { Button, ErrorNote, Field, inputCls } from '../components/ui';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { neonAuthEnabled, neonToken } from '../lib/neonAuth';
import { useI18n } from '../lib/i18n';

export function Login() {
  const { t } = useI18n();
  const { login, register, loginWithNeon } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ name: '', orgName: '', email: '', password: '', totp: '' });
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'register') {
        await register({ name: form.name, orgName: form.orgName, email: form.email, password: form.password });
      } else {
        await login({ email: form.email, password: form.password, totp: form.totp || undefined });
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'mfa_required') {
        setNeedsTotp(true);
      } else {
        setError(err instanceof ApiError ? err.message : t('err.generic'));
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitNeon() {
    setBusy(true);
    setError(null);
    try {
      const token = await neonToken(mode, { email: form.email, password: form.password, name: form.name || form.email.split('@')[0]! });
      await loginWithNeon(token, form.totp || undefined);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'mfa_required') setNeedsTotp(true);
      else setError(err instanceof Error ? err.message : t('err.generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <div className="mb-4 text-lg">
            <Logo size={44} subtitle />
          </div>
          <p className="text-muted">{t('auth.tagline')}</p>
        </div>

        <div role="tablist" className="mb-5 flex gap-1 border-b border-line">
          {(['login', 'register'] as const).map((m) => (
            <button
              key={m}
              role="tab"
              type="button"
              aria-selected={mode === m}
              onClick={() => {
                setMode(m);
                setError(null);
              }}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${mode === m ? 'border-fg text-fg' : 'border-transparent text-muted hover:text-fg'}`}
            >
              {t(m === 'login' ? 'auth.login' : 'auth.register')}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="space-y-4">
          {mode === 'register' && (
            <>
              <Field label={t('auth.name')}>
                <input required className={inputCls} value={form.name} onChange={set('name')} autoComplete="name" />
              </Field>
              <Field label={t('auth.org')}>
                <input required className={inputCls} value={form.orgName} onChange={set('orgName')} autoComplete="organization" />
              </Field>
            </>
          )}
          <Field label={t('auth.email')}>
            <input required type="email" className={inputCls} value={form.email} onChange={set('email')} autoComplete="email" />
          </Field>
          <Field label={t('auth.password')} hint={mode === 'register' ? t('auth.passwordHint') : undefined}>
            <input
              required
              type="password"
              minLength={mode === 'register' ? 12 : 1}
              className={inputCls}
              value={form.password}
              onChange={set('password')}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            />
          </Field>
          {needsTotp && mode === 'login' && (
            <Field label={t('auth.totp')}>
              <input
                required
                autoFocus
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                className={`${inputCls} font-mono tracking-widest`}
                value={form.totp}
                onChange={set('totp')}
                autoComplete="one-time-code"
              />
            </Field>
          )}
          {error && <ErrorNote message={error} />}
          <Button type="submit" variant="primary" disabled={busy} className="w-full">
            {t(mode === 'login' ? 'auth.login' : 'auth.register')}
          </Button>
        </form>

        {neonAuthEnabled && (
          <>
            <div className="my-4 flex items-center gap-3 text-xs text-faint" aria-hidden>
              <span className="h-px flex-1 bg-line" />
              {t('auth.or')}
              <span className="h-px flex-1 bg-line" />
            </div>
            <Button
              variant="secondary"
              disabled={busy || !form.email || !form.password || (mode === 'register' && !form.name)}
              onClick={() => void submitNeon()}
              className="w-full"
            >
              {t(mode === 'login' ? 'auth.neonLogin' : 'auth.neonRegister')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
