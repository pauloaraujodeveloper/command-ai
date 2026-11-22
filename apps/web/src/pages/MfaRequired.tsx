import { Logo } from '../components/Logo';
import { MfaSetup } from '../components/MfaSetup';
import { Button } from '../components/ui';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';

/** Tela única de uma sessão limitada: nada do painel abre antes de o segundo fator estar ativo. */
export function MfaRequired() {
  const { t } = useI18n();
  const { logout } = useAuth();
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-md">
        <div className="mb-6">
          <Logo size={40} subtitle />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">{t('mfa.required.title')}</h1>
        <p className="mb-6 mt-2 text-muted">{t('mfa.required.body')}</p>
        <MfaSetup />
        <div className="mt-8">
          <Button variant="ghost" onClick={() => void logout()}>
            {t('auth.logout')}
          </Button>
        </div>
      </div>
    </div>
  );
}
