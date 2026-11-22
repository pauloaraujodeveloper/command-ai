# PRD v2.0: onde está cada requisito

O PRD completo está em `Command AI PRD v2.0.md` (fora do repositório, na pasta Downloads). Esta página só mapeia o que ele pede para o que existe hoje.
O quadro de pendências está no [README](../README.md#status-em-relação-ao-prd-v2).

| Seção do PRD | Onde está no código |
| --- | --- |
| Escopo e MVP vertical | `apps/*` (etapas 1 a 3 em versão inicial) |
| Experiência do usuário (8 áreas, Ctrl K) | `apps/web/src/components/Shell.tsx`, `CommandPalette.tsx` |
| Grafo de execução ao vivo | `apps/web/src/components/ExecutionGraph.tsx` |
| Fila de aprovações (A, R, J, K) | `apps/web/src/pages/Approvals.tsx` |
| Design system (cor significa estado) | `apps/web/src/index.css` (tokens), `components/ui.tsx` |
| Orquestrador e execução durável | `apps/api/src/orchestrator.ts`, `packages/shared/src/index.ts` (máquina de estados) |
| Local Runner | `apps/runner/src` (agente em `src/agent`; ver [ADR 0005](adr/0005-agente-e-sandbox.md)) |
| Aprovação humana de operações críticas, sandbox, limites de tempo/tokens/custo | `apps/runner/src/agent/policy.ts`, `sandbox.ts`, `loop.ts`; `apps/web/src/pages/Approvals.tsx` |
| Segurança | `apps/api/src/auth.ts`, `app.ts`; ver [SECURITY.md](SECURITY.md) |
| Modelo de dados | `apps/api/migrations/001_init.sql`, `persistence.ts` |
| API e eventos com seq e replay | `apps/api/src/app.ts` (`/executions/:id/events`) |
| Custos e orçamento que interrompe | `orchestrator.ts` (`recordUsage`), `packages/shared` (`costFor`) |
| Requisitos não funcionais | Parcial: i18n pt-BR/en, foco visível, movimento reduzido; sem medição de p95 ainda |
