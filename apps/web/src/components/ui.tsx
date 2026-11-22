import { Ban, Check, Circle, CircleDashed, Hourglass, Loader2, Pencil, X, type LucideIcon } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useI18n, type MessageKey } from '../lib/i18n';

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

/* ---------------- botões e campos ---------------- */

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANTS: Record<Variant, string> = {
  // Botão primário invertido: claro sobre escuro e o contrário.
  primary: 'bg-inv-bg text-inv-fg hover:opacity-90',
  secondary: 'border border-line-strong bg-surface text-fg hover:bg-raised',
  danger: 'border border-fail text-fail hover:bg-fail/10',
  ghost: 'text-muted hover:bg-raised hover:text-fg',
};

export function Button({
  variant = 'secondary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        className,
      )}
    />
  );
}

export const inputCls =
  'w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-fg placeholder:text-faint';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-fg">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

/* ---------------- estado: sempre ícone + texto + cor ---------------- */

interface StateStyle {
  text: string;
  border: string;
  Icon: LucideIcon;
  spin?: boolean;
}

export const STATE: Record<string, StateStyle> = {
  running: { text: 'text-run', border: 'border-run', Icon: Loader2, spin: true },
  waiting_approval: { text: 'text-wait', border: 'border-wait', Icon: Hourglass },
  done: { text: 'text-done', border: 'border-done', Icon: Check },
  succeeded: { text: 'text-done', border: 'border-done', Icon: Check },
  failed: { text: 'text-fail', border: 'border-fail', Icon: X },
  cancelled: { text: 'text-queue', border: 'border-line-strong', Icon: Ban },
  queued: { text: 'text-queue', border: 'border-line-strong', Icon: CircleDashed },
  pending: { text: 'text-queue', border: 'border-line', Icon: Circle },
  draft: { text: 'text-queue', border: 'border-line-strong', Icon: Pencil },
};

export function StateIcon({ status, size = 16 }: { status: string; size?: number }) {
  const s = STATE[status] ?? STATE.pending!;
  return <s.Icon size={size} aria-hidden className={cx(s.text, s.spin && 'ca-spin', 'shrink-0')} />;
}

export function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const s = STATE[status] ?? STATE.pending!;
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-sm font-medium', s.text)}>
      <StateIcon status={status} size={15} />
      {t(`status.${status}` as MessageKey)}
    </span>
  );
}

export function RiskBadge({ risk }: { risk: 'low' | 'medium' | 'high' }) {
  const { t } = useI18n();
  const color = risk === 'high' ? 'text-fail' : risk === 'medium' ? 'text-wait' : 'text-muted';
  const bars = risk === 'high' ? 3 : risk === 'medium' ? 2 : 1;
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-sm', color)}>
      <span aria-hidden className="flex items-end gap-0.5">
        {[1, 2, 3].map((n) => (
          <span key={n} className={cx('w-1 rounded-sm', n <= bars ? 'bg-current' : 'bg-line-strong')} style={{ height: 4 + n * 3 }} />
        ))}
      </span>
      {t(`risk.${risk}` as MessageKey)}
    </span>
  );
}

/* ---------------- estados de tela ---------------- */

export function Spinner({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div role="status" className="flex items-center gap-2 py-8 text-muted">
      <Loader2 size={16} className="ca-spin" aria-hidden />
      {label ?? t('common.loading')}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useI18n();
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-fail/60 bg-fail/10 px-3 py-2.5 text-sm text-fail">
      <span>{message}</span>
      {onRetry && (
        <Button variant="ghost" onClick={onRetry} className="!px-2 !py-1 text-fail">
          {t('common.retry')}
        </Button>
      )}
    </div>
  );
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-line-strong px-4 py-8 text-center text-muted">
      <p>{children}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {children}
    </div>
  );
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export const money = (n: number) => `US$ ${n.toFixed(n < 1 ? 4 : 2)}`;
