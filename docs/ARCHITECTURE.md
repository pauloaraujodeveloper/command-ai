# Arquitetura

```
 Navegador / PWA / Electron ──HTTPS──▶  API Fastify ×N (apps/api, sem estado)  ──┐
        │  cookie HttpOnly + SSE              │   ▲                               │ pg (papel restrito, RLS)
        └──── Neon Auth (login) ──────────────┘   └─ JWT do Neon (JWKS)           ▼
                                                                          PostgreSQL (Neon)
 Runner (apps/runner) ──HTTPS de saída──▶ API   ┐                                ▲
   token revogável, trabalho assinado,           │ eventos ao vivo                │
   heartbeat, cancelamento                       ▼ (pub/sub)                      │
                                              Redis ◀── BullMQ ──▶ Worker (apps/api, `pnpm worker`) ──┘
                                                       varredura de recuperação
```

Só o Runner roda na máquina do usuário, e é ele quem abre a conexão com a API, nunca o contrário.

## Camadas

- **API (`apps/api`).** Sem estado: cada requisição roda numa **unidade de trabalho** (uma transação por organização, com o contexto do RLS). `app.ts` define as rotas; `orchestrator.ts` concentra as regras; `repo.ts`/`pg-repo.ts` abrem as unidades; `store.ts` é o espaço de trabalho síncrono dentro de cada unidade. Ver [ADR 0002](adr/0002-persistencia-unidade-de-trabalho.md).
- **Orquestrador.** O plano é validado (`validatePlan`), cada tarefa só inicia com as dependências concluídas, risco alto cria uma aprovação, o orçamento interrompe a execução e toda transição passa por `canTransitionTask`. Confiabilidade: lease com heartbeat, espera progressiva entre tentativas, prazo da execução, relatórios idempotentes com número da tentativa e cancelamento propagado ao Runner. Ver [ADR 0001](adr/0001-motor-de-execucao.md).
- **Worker (`worker.ts`).** Processo próprio e sem porta. Roda a varredura de recuperação por BullMQ (Redis) ou por relógio em processo (sem Redis). Pode haver vários.
- **Eventos.** Cada evento tem `seq` por execução, atribuído sob a trava da organização. O SSE assina o barramento (Redis entre processos), relê o passado do banco, deduplica por `seq` e confere o banco a cada 10 s. O cliente reconecta com `Last-Event-ID`.
- **Entrega de tarefas.** Atômica no PostgreSQL, nunca no Redis: perder o Redis não perde tarefas.
- **Runner e agente (`apps/runner`).** O Runner busca trabalho assinado, mantém o heartbeat e executa o agente (`src/agent`): laço de interações com o modelo (`loop.ts`), ferramentas de arquivo com guarda de caminho (`tools.ts`, `workspace.ts`), worktree Git por tentativa (`worktree.ts`), política e aprovação humana (`policy.ts`), sandbox Docker para comandos (`sandbox.ts`) e cliente do SDK oficial (`anthropic-client.ts`). A API só recebe relatos: log, uso por turno, pedidos de aprovação e o resultado. Ver [ADR 0005](adr/0005-agente-e-sandbox.md).
- **Web (`apps/web`).** React 19, Vite, Tailwind v4. A API a serve na mesma origem quando `apps/web/dist` existe.
- **Desktop (`apps/desktop`).** Cliente fino: abre a URL do servidor num `BrowserWindow` em sandbox, sem Node na página. Ver [ADR 0004](adr/0004-pwa-e-desktop.md).

## Decisões

1. [Motor de execução](adr/0001-motor-de-execucao.md)
2. [Persistência por unidade de trabalho](adr/0002-persistencia-unidade-de-trabalho.md)
3. [Neon Auth como identidade, sessão própria](adr/0003-neon-auth-e-sessao.md)
4. [PWA e desktop](adr/0004-pwa-e-desktop.md)
5. [Agente com ferramentas, aprovação humana e sandbox](adr/0005-agente-e-sandbox.md)
