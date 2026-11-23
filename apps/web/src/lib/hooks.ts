import { useCallback, useEffect, useRef, useState } from 'react';
import { EVENT_TYPES } from '@command-ai/shared';
import { ApiError, type EventEnvelope } from './api';

export function useQuery<T>(fn: () => Promise<T>, deps: unknown[] = [], refetchMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setData(await fnRef.current());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'network', 'Sem conexão com o servidor.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    if (!refetchMs) return;
    const id = setInterval(() => void reload(true), refetchMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, refetchMs, reload]);

  return { data, error, loading, reload };
}

// EVENT_TYPES vem do pacote compartilhado: o SSE entrega cada tipo com nome próprio, e um tipo que falte aqui nunca chegaria à tela.

/**
 * Assina os eventos de uma execução por SSE. Ao reconectar o navegador reenvia Last-Event-ID
 * e o servidor reenvia só o que faltou; aqui deduplicamos por seq por segurança.
 */
export function useExecutionEvents(executionId: string | undefined, onEvent?: (e: EventEnvelope) => void) {
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [connected, setConnected] = useState(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!executionId) return;
    setEvents([]);
    const source = new EventSource(`/api/v1/executions/${encodeURIComponent(executionId)}/events?after=0`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    const handler = (msg: MessageEvent<string>) => {
      const event = JSON.parse(msg.data) as EventEnvelope;
      setEvents((prev) => {
        if (prev.some((p) => p.seq === event.seq)) return prev;
        return [...prev, event].sort((a, b) => a.seq - b.seq);
      });
      onEventRef.current?.(event);
    };
    for (const type of EVENT_TYPES) source.addEventListener(type, handler as EventListener);
    return () => source.close();
  }, [executionId]);

  return { events, connected };
}

/** Atalhos de teclado que não disparam enquanto a pessoa digita em um campo. */
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, enabled = true) {
  const mapRef = useRef(map);
  mapRef.current = map;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      mapRef.current[e.key.toLowerCase()]?.(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
