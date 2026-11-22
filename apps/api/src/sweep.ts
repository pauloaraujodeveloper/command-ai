import type { Repo } from './repo.ts';

export interface SweepSummary {
  orgs: number;
  requeued: number;
  failed: number;
  expiredExecutions: number;
  errors: number;
}

/**
 * Varredura de recuperação: para cada organização com execução em andamento, devolve à fila (ou falha) as tarefas cujo
 * lease venceu e encerra execuções que passaram do prazo. Cada organização é uma unidade de trabalho própria: um erro
 * numa não impede as outras. É idempotente e segura com vários Workers (a trava por organização serializa).
 */
export async function runSweep(repo: Repo, opts: { log?: (message: string, err?: unknown) => void } = {}): Promise<SweepSummary> {
  const log = opts.log ?? ((m, e) => console.error(m, e));
  const total: SweepSummary = { orgs: 0, requeued: 0, failed: 0, expiredExecutions: 0, errors: 0 };
  for (const org of await repo.listActiveOrganizationIds()) {
    total.orgs++;
    try {
      const r = await repo.uow(org, 'write', ({ orchestrator }) => orchestrator.sweep());
      total.requeued += r.requeued;
      total.failed += r.failed;
      total.expiredExecutions += r.expiredExecutions;
    } catch (err) {
      total.errors++;
      log(`[sweep] falha ao varrer a organização ${org}`, err);
    }
  }
  return total;
}
