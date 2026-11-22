import { Bot, Download, FolderGit2, Home, ListChecks, LogOut, Play, Plug, Search, Settings, ShieldCheck, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import type { Approval } from '../lib/api';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useQuery } from '../lib/hooks';
import { useI18n, type MessageKey } from '../lib/i18n';
import { useInstallPrompt } from '../lib/install';
import { CommandPalette, type PaletteCommand } from './CommandPalette';
import { Logo } from './Logo';
import { cx } from './ui';

interface NavItem {
  to: string;
  key: MessageKey;
  Icon: LucideIcon;
  end?: boolean;
}

export const NAV: NavItem[] = [
  { to: '/', key: 'nav.home', Icon: Home, end: true },
  { to: '/nova', key: 'nav.new', Icon: Play },
  { to: '/execucoes', key: 'nav.runs', Icon: ListChecks },
  { to: '/aprovacoes', key: 'nav.approvals', Icon: ShieldCheck },
  { to: '/agentes', key: 'nav.agents', Icon: Bot },
  { to: '/projetos', key: 'nav.projects', Icon: FolderGit2 },
  { to: '/integracoes', key: 'nav.integrations', Icon: Plug },
  { to: '/administracao', key: 'nav.admin', Icon: Settings },
];

function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem('ca-theme', next);
  } catch {
    /* sem armazenamento */
  }
}

export function Shell() {
  const { t, lang, setLang } = useI18n();
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { canInstall, install } = useInstallPrompt();

  const pending = useQuery(() => api<{ items: Approval[] }>('/approvals?status=pending'), [], 5000);
  const pendingCount = pending.data?.items.length ?? 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const closePalette = useCallback(() => setPaletteOpen(false), []);

  const commands = useMemo<PaletteCommand[]>(
    () => [
      ...NAV.map<PaletteCommand>((n) => ({ id: `go-${n.to}`, label: t(n.key), group: 'go', run: () => navigate(n.to) })),
      { id: 'theme', label: t('pal.theme'), group: 'actions', run: toggleTheme },
      { id: 'lang', label: t('pal.lang'), group: 'actions', run: () => setLang(lang === 'en' ? 'pt-BR' : 'en') },
      ...(canInstall ? [{ id: 'install', label: t('install.app'), group: 'actions' as const, run: () => void install() }] : []),
      { id: 'logout', label: t('auth.logout'), group: 'actions', run: () => void logout() },
    ],
    [t, navigate, lang, setLang, logout, canInstall, install],
  );

  return (
    <div className="min-h-screen md:grid md:grid-cols-[232px_1fr]">
      <a href="#conteudo" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-inv-bg focus:px-3 focus:py-2 focus:text-inv-fg">
        {t('shell.skip')}
      </a>

      <aside className="border-b border-line bg-surface md:sticky md:top-0 md:h-screen md:border-b-0 md:border-r">
        <div className="flex items-center justify-between px-4 py-3 md:py-5">
          <Logo size={30} subtitle />
        </div>

        <nav aria-label="Áreas" className="scroll-thin flex gap-1 overflow-x-auto px-2 pb-2 md:block md:space-y-0.5 md:overflow-visible md:pb-0">
          {NAV.map(({ to, key, Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cx(
                  'flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-sm',
                  isActive ? 'bg-raised font-medium text-fg' : 'text-muted hover:bg-raised hover:text-fg',
                )
              }
            >
              <Icon size={17} aria-hidden />
              <span>{t(key)}</span>
              {to === '/aprovacoes' && pendingCount > 0 && (
                <span aria-label={`${pendingCount}`} className="ml-auto rounded-full bg-wait px-1.5 text-xs font-semibold text-black">
                  {pendingCount}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto hidden border-t border-line p-3 md:absolute md:bottom-0 md:left-0 md:block md:w-[232px]">
          <div className="mb-2 truncate px-1 text-sm">
            <div className="truncate font-medium">{me?.user.name}</div>
            <div className="truncate text-xs text-muted">{me?.organization.name}</div>
          </div>
          {canInstall && (
            <button
              type="button"
              onClick={() => void install()}
              className="mb-1 flex w-full items-center gap-2 rounded-md border border-line-strong px-2 py-1.5 text-sm text-fg hover:bg-raised"
            >
              <Download size={15} aria-hidden />
              {t('install.app')}
            </button>
          )}
          <button
            type="button"
            onClick={() => void logout()}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted hover:bg-raised hover:text-fg"
          >
            <LogOut size={15} aria-hidden />
            {t('auth.logout')}
          </button>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-20 flex items-center justify-end gap-2 border-b border-line bg-bg/90 px-4 py-2.5 backdrop-blur md:px-8">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label={t('pal.open')}
            className="flex w-full max-w-xs items-center gap-2 rounded-md border border-line-strong bg-surface px-3 py-1.5 text-sm text-muted hover:text-fg md:w-auto md:min-w-[260px]"
          >
            <Search size={15} aria-hidden />
            <span className="flex-1 text-left">{t('pal.placeholder')}</span>
            <kbd className="rounded border border-line-strong px-1.5 font-mono text-xs">Ctrl K</kbd>
          </button>
        </header>
        <main id="conteudo" tabIndex={-1} className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">
          <Outlet />
        </main>
      </div>

      <CommandPalette open={paletteOpen} onClose={closePalette} commands={commands} />
    </div>
  );
}
