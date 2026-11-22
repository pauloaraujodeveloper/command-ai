import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n, type MessageKey } from '../lib/i18n';
import { cx } from './ui';

export interface PaletteCommand {
  id: string;
  label: string;
  group: 'go' | 'actions';
  run: () => void;
}

export function CommandPalette({ open, onClose, commands }: { open: boolean; onClose: () => void; commands: PaletteCommand[] }) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
      // Foco no campo ao abrir.
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands;
  }, [commands, query]);

  useEffect(() => setIndex(0), [query]);

  if (!open) return null;

  const run = (c: PaletteCommand | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(filtered[index]);
    }
  };

  const groups: Array<['go' | 'actions', MessageKey]> = [
    ['go', 'pal.go'],
    ['actions', 'pal.actions'],
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-4 pt-[12vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('pal.open')}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="w-full max-w-lg overflow-hidden rounded-lg border border-line-strong bg-surface"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('pal.placeholder')}
          aria-label={t('pal.placeholder')}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={filtered[index] ? `pal-${filtered[index]!.id}` : undefined}
          className="w-full border-b border-line bg-transparent px-4 py-3.5 text-base text-fg placeholder:text-faint focus-visible:outline-none"
        />
        <ul id="palette-list" role="listbox" className="scroll-thin max-h-[50vh] overflow-y-auto p-1.5">
          {filtered.length === 0 && <li className="px-3 py-6 text-center text-muted">{t('pal.none')}</li>}
          {groups.map(([group, labelKey]) => {
            const items = filtered.filter((c) => c.group === group);
            if (items.length === 0) return null;
            return (
              <li key={group} role="presentation">
                <div className="px-3 pb-1 pt-2 text-xs font-medium text-faint">{t(labelKey)}</div>
                <ul role="presentation">
                  {items.map((c) => {
                    const i = filtered.indexOf(c);
                    return (
                      <li
                        key={c.id}
                        id={`pal-${c.id}`}
                        role="option"
                        aria-selected={i === index}
                        onMouseMove={() => setIndex(i)}
                        onClick={() => run(c)}
                        className={cx('cursor-pointer rounded-md px-3 py-2 text-sm', i === index ? 'bg-raised text-fg' : 'text-muted')}
                      >
                        {c.label}
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
