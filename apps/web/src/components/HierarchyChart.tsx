import { Bot, FileText, Mail, MessageSquare, Network } from 'lucide-react';
import { useMemo } from 'react';
import type { Hierarchy, HNode } from '@command-ai/shared/hierarchy';
import { useI18n, type MessageKey } from '../lib/i18n';
import { cx, STATE, StateIcon } from './ui';

const W = 196;
const GAP_X = 28;
const GAP_Y = 54;
const SIMPLE_H = 60;
const MAX_TASK_ROWS = 4;

function heightOf(n: HNode, mode: 'team' | 'execution'): number {
  if (n.kind !== 'agent') return SIMPLE_H;
  const rows = mode === 'execution' ? Math.min(n.tasks?.length ?? 0, MAX_TASK_ROWS) + ((n.tasks?.length ?? 0) > MAX_TASK_ROWS ? 1 : 0) : 0;
  return 66 + rows * 20 + (mode === 'team' ? 22 : 0) + (n.sent + n.received > 0 ? 18 : 0);
}

interface Box {
  node: HNode;
  x: number;
  y: number;
  h: number;
}

function layout(h: Hierarchy, mode: 'team' | 'execution') {
  const levelH = new Map<number, number>();
  for (const n of h.nodes) levelH.set(n.level, Math.max(levelH.get(n.level) ?? 0, heightOf(n, mode)));
  const top = new Map<number, number>();
  let y = 0;
  for (let l = 0; l < h.levels; l++) {
    top.set(l, y);
    y += (levelH.get(l) ?? SIMPLE_H) + GAP_Y;
  }
  const boxes = new Map<string, Box>();
  for (const n of h.nodes) boxes.set(n.id, { node: n, x: n.slot * (W + GAP_X), y: top.get(n.level) ?? 0, h: levelH.get(n.level) ?? SIMPLE_H });
  return { boxes, width: h.slots * W + (h.slots - 1) * GAP_X, height: Math.max(0, y - GAP_Y) };
}

/**
 * Hierarquia de agentes no estilo do diagrama de orquestração: pedido → orquestrador → especialistas → resultado.
 * O estado vem de ícone + texto + cor (nunca só cor). Linhas: cheia = delegação; tracejada = alimenta o resultado; pontilhada com seta = dependência entre agentes.
 */
export function HierarchyChart({
  hierarchy,
  mode,
  requestText,
  resultStatus,
  selectedId,
  onSelect,
}: {
  hierarchy: Hierarchy;
  mode: 'team' | 'execution';
  requestText?: string;
  resultStatus?: string;
  selectedId?: string | null;
  onSelect?: (agentId: string | null) => void;
}) {
  const { t } = useI18n();
  const { boxes, width, height } = useMemo(() => layout(hierarchy, mode), [hierarchy, mode]);
  const deps = hierarchy.edges.filter((e) => e.kind === 'dependency');

  return (
    <figure className="m-0">
      <div className="scroll-thin overflow-x-auto rounded-lg border border-line bg-surface p-4">
        <div className="relative mx-auto" style={{ width, height: height + 24, minWidth: Math.min(width, 320) }}>
          <svg width={width} height={height + 24} className="absolute inset-0" aria-hidden>
            <defs>
              <marker id="ca-dep-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="var(--run)" />
              </marker>
            </defs>
            {hierarchy.edges
              .filter((e) => e.kind !== 'dependency')
              .map((e) => {
                const a = boxes.get(e.from);
                const b = boxes.get(e.to);
                if (!a || !b) return null;
                const x1 = a.x + W / 2;
                const y1 = a.y + a.h;
                const x2 = b.x + W / 2;
                const y2 = b.y;
                const mid = y2 - GAP_Y / 2;
                const live = e.kind === 'tree' && (a.node.status === 'done' || a.node.kind === 'request');
                return (
                  <path
                    key={`${e.from}>${e.to}:${e.kind}`}
                    d={`M${x1},${y1} V${mid} H${x2} V${y2}`}
                    fill="none"
                    stroke={live ? 'var(--done)' : 'var(--line-strong)'}
                    strokeWidth={live ? 1.75 : 1.25}
                    strokeDasharray={e.kind === 'result' ? '5 4' : undefined}
                  />
                );
              })}
            {deps.map((e, i) => {
              const a = boxes.get(e.from);
              const b = boxes.get(e.to);
              if (!a || !b) return null;
              const x1 = a.x + W / 2 + 14;
              const x2 = b.x + W / 2 - 14;
              const y1 = a.y + a.h;
              const y2 = b.y + b.h;
              const drop = Math.min(GAP_Y - 14, 8 + (i % 4) * 5);
              const yb = Math.max(y1, y2) + drop;
              return <path key={`${e.from}>${e.to}:dep`} d={`M${x1},${y1} V${yb} H${x2} V${y2 + 2}`} fill="none" stroke="var(--run)" strokeWidth={1.5} strokeDasharray="1.5 4" strokeLinecap="round" markerEnd="url(#ca-dep-arrow)" />;
            })}
          </svg>

          {[...boxes.values()].map(({ node: n, x, y, h }) => (
            <NodeCard key={n.id} n={n} x={x} y={y} h={h} mode={mode} requestText={requestText} resultStatus={resultStatus} selected={selectedId === n.id} onSelect={onSelect} />
          ))}
        </div>
      </div>
      <figcaption className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted">
        <span className="sr-only">{t('team.legend')}</span>
        <Legend label={t('team.legendTree')}>
          <line x1="0" y1="5" x2="26" y2="5" stroke="var(--line-strong)" strokeWidth="1.5" />
        </Legend>
        <Legend label={t('team.legendResult')}>
          <line x1="0" y1="5" x2="26" y2="5" stroke="var(--line-strong)" strokeWidth="1.5" strokeDasharray="5 4" />
        </Legend>
        {mode === 'execution' && (
          <Legend label={t('team.legendDep')}>
            <line x1="0" y1="5" x2="22" y2="5" stroke="var(--run)" strokeWidth="1.5" strokeDasharray="1.5 4" strokeLinecap="round" />
            <path d="M20,1 L26,5 L20,9 z" fill="var(--run)" />
          </Legend>
        )}
      </figcaption>
    </figure>
  );
}

function Legend({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <svg width="28" height="10" aria-hidden>
        {children}
      </svg>
      {label}
    </span>
  );
}

function NodeCard({
  n,
  x,
  y,
  h,
  mode,
  requestText,
  resultStatus,
  selected,
  onSelect,
}: {
  n: HNode;
  x: number;
  y: number;
  h: number;
  mode: 'team' | 'execution';
  requestText?: string;
  resultStatus?: string;
  selected: boolean;
  onSelect?: (agentId: string | null) => void;
}) {
  const { t } = useI18n();
  const box = { left: x, top: y, width: W, height: h };

  if (n.kind === 'request') {
    return (
      <div style={box} className="absolute flex items-center gap-3 rounded-full border border-line-strong bg-raised px-4">
        <MessageSquare size={18} aria-hidden className="shrink-0 text-muted" />
        <div className="min-w-0">
          <div className="text-xs text-muted">{t('team.request')}</div>
          <div className="line-clamp-2 text-sm font-medium leading-snug">{mode === 'team' ? t('team.you') : requestText || t('team.you')}</div>
        </div>
      </div>
    );
  }
  if (n.kind === 'result') {
    const s = STATE[resultStatus ?? ''] ?? null;
    return (
      <div style={box} className={cx('absolute flex items-center gap-3 rounded-md border bg-raised px-4', s ? s.border : 'border-line-strong')}>
        <FileText size={18} aria-hidden className={cx('shrink-0', s ? s.text : 'text-muted')} />
        <div className="min-w-0">
          <div className="text-sm font-medium">{t('team.result')}</div>
          <div className="flex items-center gap-1.5 text-xs text-muted">
            {resultStatus ? (
              <>
                <StateIcon status={resultStatus} size={12} />
                {t(`status.${resultStatus}` as MessageKey)}
              </>
            ) : (
              t('team.resultSub')
            )}
          </div>
        </div>
      </div>
    );
  }

  const a = n.agent!;
  const orch = a.kind === 'orchestrator';
  const s = n.status ? STATE[n.status] : undefined;
  const Icon = orch ? Network : Bot;
  const scopes = a.writeScopes;
  const scopeText = scopes === undefined ? t('team.noRestriction') : scopes.length === 0 ? t('team.readOnly') : `${t('team.canWrite')}: ${scopes.slice(0, 2).join(', ')}${scopes.length > 2 ? ` +${scopes.length - 2}` : ''}`;
  const tasks = n.tasks ?? [];
  const inner = (
    <>
      <div className="flex items-start gap-2">
        <Icon size={17} aria-hidden className={cx('mt-0.5 shrink-0', orch ? 'text-wait' : 'text-muted')} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold leading-tight">{n.removed ? t('team.removedAgent') : a.name}</div>
          <div className="truncate text-xs text-muted">
            {orch ? t('team.kind.orchestrator') : t('team.kind.specialist')}
            {a.domain ? ` · ${a.domain}` : ''}
          </div>
        </div>
        {n.status && (
          <span className={cx('inline-flex shrink-0 items-center gap-1 text-xs', s?.text)}>
            <StateIcon status={n.status} size={13} />
            <span className="sr-only">{t(`status.${n.status}` as MessageKey)}</span>
          </span>
        )}
      </div>
      {mode === 'team' && <div className="mt-1.5 truncate text-xs text-muted" title={scopes?.join(', ')}>{scopeText}</div>}
      {mode === 'team' && a.dependsOnDomains && a.dependsOnDomains.length > 0 && <div className="truncate text-xs text-muted">{t('team.dependsOn')}: {a.dependsOnDomains.join(', ')}</div>}
      {mode === 'execution' && tasks.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {tasks.slice(0, MAX_TASK_ROWS).map((task) => (
            <li key={task.id} className="flex items-center gap-1.5 text-xs">
              <StateIcon status={task.status} size={11} />
              <span className="truncate" title={task.title}>{task.title}</span>
            </li>
          ))}
          {tasks.length > MAX_TASK_ROWS && <li className="text-xs text-muted">+{tasks.length - MAX_TASK_ROWS}</li>}
        </ul>
      )}
      {n.sent + n.received > 0 && (
        <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted" title={`${n.sent} ${t('team.sent')}, ${n.received} ${t('team.received')}`}>
          <Mail size={12} aria-hidden />
          {n.sent}↑ {n.received}↓ {t('team.messages')}
        </div>
      )}
    </>
  );
  const cls = cx(
    'absolute flex flex-col rounded-md border bg-bg px-3 py-2.5 text-left',
    s ? s.border : orch ? 'border-wait/70' : 'border-line-strong',
    n.status === 'waiting_approval' && 'ca-await',
    selected && 'outline outline-2 outline-offset-2 outline-fg',
    onSelect && 'transition-colors hover:bg-raised',
  );
  const label = `${a.name}. ${orch ? t('team.kind.orchestrator') : t('team.kind.specialist')}${a.domain ? `, ${a.domain}` : ''}`;
  return onSelect ? (
    <button type="button" aria-pressed={selected} aria-label={label} style={box} className={cls} onClick={() => onSelect(selected ? null : n.id)}>
      {inner}
    </button>
  ) : (
    <div style={box} className={cls} aria-label={label}>
      {inner}
    </div>
  );
}
