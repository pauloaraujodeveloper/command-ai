# ADR 0001: motor de execução

Status: aceita para o MVP; a prova de conceito em motor durável (Temporal, Inngest, Restate) **continua em aberto**.

## Contexto

O PRD propõe BullMQ com o estado no PostgreSQL atrás de uma interface `WorkflowEngine`, e uma prova de conceito em um motor durável antes da etapa 3. O requisito de fundo: perder um processo (API, Worker ou Runner) não pode perder trabalho nem deixar tarefa presa.

## Decisão

Dividir o problema em duas partes com donos diferentes:

1. **Entrega de tarefas ao Runner: PostgreSQL.** O orquestrador roda dentro de uma transação por organização, com trava consultiva (`pg_advisory_xact_lock`). Reivindicar uma tarefa é atômico: com duas instâncias da API competindo, só uma vence (teste de concorrência com mutação). O Redis não faz parte desse caminho, então **perder o Redis nunca perde uma tarefa**.
2. **Tarefas ligadas ao tempo: BullMQ sobre Redis**, atrás de `WorkflowEngine` (`IntervalEngine` sem Redis, `BullMqEngine` com Redis). Hoje há um só tipo de trabalho, a **varredura de recuperação**, agendada com id fixo (`upsertJobScheduler`): com vários Workers, cada ciclo roda uma vez no total. No boot o Worker pede uma varredura imediata.

Mecanismos de confiabilidade (todos no orquestrador, testados sem rede em `lease.test.ts`):

- **Lease + heartbeat.** Tarefa reivindicada ganha lease (padrão 60 s). O Runner renova a cada lease/3. Lease vencido: a varredura devolve a tarefa à fila (ou a falha, se as tentativas acabaram).
- **Espera progressiva** entre tentativas (`BACKOFF_BASE_MS` × 2^(n-1), até `BACKOFF_MAX_MS`), guardada na própria tarefa (`notBefore`): nenhum relógio externo é necessário.
- **Prazo da execução** (`MAX_EXECUTION_MS`, padrão 2 h): passado, a execução falha com `deadline_exceeded` e o resto é cancelado. Não conta o tempo parado esperando aprovação.
- **Relatórios idempotentes e com número da tentativa.** Concluir duas vezes, relatar uma tentativa antiga ou relatar depois de cancelar volta 200 com `applied: false`, sem efeito (o custo não é contado em dobro).
- **Cancelamento** chega ao Runner na resposta do heartbeat; o Runner interrompe o executor (`AbortSignal`) e não envia relatório.

## Alternativas

- **BullMQ também para entregar tarefas.** Os Runners são clientes HTTP remotos, não consumidores BullMQ; usar `getNextJob` manual obrigaria a renovar travas do BullMQ por conta do Runner e deixaria o Redis como ponto único de perda de tarefas. Descartado.
- **Fila só no PostgreSQL, sem Redis.** Funciona (o `IntervalEngine` prova), mas o PRD prevê BullMQ e o Redis também serve de canal de eventos entre processos. Mantido como modo degradado: sem `REDIS_URL` tudo funciona, com uma instância de eventos ao vivo.
- **Temporal, Inngest, Restate.** Não avaliados na prática. Reabrir se surgirem execuções muito longas ou fluxos com muitos sinais externos.

## Consequências

- Todas as escritas de uma organização são serializadas pela trava (heartbeats, linhas de log e relatórios incluídos). O limite de vazão por organização **não foi medido**.
- Cada requisição carrega os registros da organização (ver ADR 0002).
- O Worker é um processo comum (`pnpm worker`), sem porta. Implantá-lo como Background Worker no Render **não foi testado**.
- Redis em produção precisa de autenticação, TLS e `maxmemory-policy noeviction`.
- Falta `Idempotency-Key` nas criações da API (previsto no PRD): um clique duplo em "Gerar plano" cria duas execuções.

## Revisão

Reabrir antes de qualquer execução longa (horas) ou quando a vazão por organização for um problema medido.
