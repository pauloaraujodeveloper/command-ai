import { useMemo } from 'react';
import type { Task } from '../lib/api';
import { useI18n, type MessageKey } from '../lib/i18n';
import { cx, RiskBadge, STATE, StateIcon } from './ui';

const W = 212;
const H = 68;
const GAP_X = 72;
const GAP_Y = 18;

interface Positioned {
  task: Task;
  x: number;
  y: number;
}

/** Camadas por profundidade (caminho mais longo até a raiz); linhas pela ordem do plano. */
function layout(tasks: Task[]): { nodes: Positioned[]; width: number; height: number } {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  const visit = (t: Task): number => {
    const known = depth.get(t.id);
    if (known !== undefined) return known;
    const parents = t.dependsOn.map((id) => byId.get(id)).filter((p): p is Task => !!p);
    const d = parents.length ? 1 + Math.max(...parents.map(visit)) : 0;
    depth.set(t.id, d);
    return d;
  };
  tasks.forEach(visit);

  const rows = new Map<number, number>();
  const nodes = tasks.map<Positioned>((task) => {
    const col = depth.get(task.id) ?? 0;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    return { task, x: col * (W + GAP_X), y: row * (H + GAP_Y) };
  });
  const cols = Math.max(0, ...depth.values()) + 1;
  const maxRows = Math.max(1, ...rows.values());
  return { nodes, width: cols * W + (cols - 1) * GAP_X, height: maxRows * H + (maxRows - 1) * GAP_Y };
}

export function ExecutionGraph({
  tasks,
  selectedId,
  onSelect,
}: {
  tasks: Task[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { t } = useI18n();
  const { nodes, width, height } = useMemo(() => layout(tasks), [tasks]);
  const pos = new Map(nodes.map((n) => [n.task.id, n]));

  return (
    <div className="scroll-thin overflow-x-auto rounded-lg border border-line bg-surface p-4">
      <div className="relative" style={{ width, height, minWidth: '100%' }}>
        <svg width={width} height={height} className="absolute inset-0" aria-hidden>
          {nodes.flatMap(({ task }) =>
            task.dependsOn.map((dep) => {
              const from = pos.get(dep);
              const to = pos.get(task.id);
              if (!from || !to) return null;
              const x1 = from.x + W;
              const y1 = from.y + H / 2;
              const x2 = to.x;
              const y2 = to.y + H / 2;
              const mid = (x1 + x2) / 2;
              const done = from.task.status === 'done';
              return (
                <path
                  key={`${dep}->${task.id}`}
                  d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                  fill="none"
                  stroke={done ? 'var(--done)' : 'var(--line-strong)'}
                  strokeWidth={done ? 1.75 : 1.25}
                  strokeDasharray={done ? undefined : '4 4'}
                />
              );
            }),
          )}
        </svg>

        {nodes.map(({ task, x, y }) => {
          const s = STATE[task.status] ?? STATE.pending!;
          const selected = selectedId === task.id;
          return (
            <button
              key={task.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(selected ? null : task.id)}
              style={{ left: x, top: y, width: W, height: H }}
              className={cx(
                'absolute flex flex-col justify-between rounded-md border bg-bg px-3 py-2 text-left transition-colors hover:bg-raised',
                s.border,
                task.status === 'waiting_approval' && 'ca-await',
                selected && 'outline outline-2 outline-offset-2 outline-fg',
                (task.status === 'pending' || task.status === 'cancelled') && 'opacity-75',
              )}
            >
              <span className="line-clamp-2 text-sm font-medium leading-snug">{task.title}</span>
              <span className="flex items-center justify-between gap-2 text-xs">
                <span className={cx('inline-flex items-center gap-1.5', s.text)}>
                  <StateIcon status={task.status} size={13} />
                  {t(`status.${task.status}` as MessageKey)}
                </span>
                {task.risk !== 'low' && <RiskBadge risk={task.risk} />}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
