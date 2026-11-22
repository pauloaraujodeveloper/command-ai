# ADR 0002: persistência por unidade de trabalho no PostgreSQL

Status: aceita para o MVP. Substitui a versão anterior ("write-through"), em que a API mantinha o estado em memória.

## Contexto

O PRD pede Prisma, um modelo normalizado e RLS. As regras de negócio (orquestrador, aprovações, orçamento) estão escritas e testadas de forma **síncrona** sobre um `Store`. Reescrevê-las para acesso assíncrono ao banco antes de validar o fluxo atrasaria o primeiro valor. Ao mesmo tempo, API e Worker em processos separados não podem compartilhar memória.

## Decisão

Cada operação roda numa **unidade de trabalho** (`Repo.begin` / `uow`), que é UMA transação:

1. abre a transação e define o contexto de organização (`app.organization_id`, local à transação) para o RLS;
2. em escrita, pega a trava consultiva da organização, o que serializa as escritas entre processos;
3. carrega os registros **da organização** para um `Store` temporário e roda o código de negócio síncrono sobre ele;
4. grava as mudanças (as do mesmo registro são fundidas), confirma, e só então publica os eventos ao vivo.

Em leitura, a fotografia vem e a transação fecha na mesma ida ao servidor, sem trava. Abrir uma unidade custa **uma ida ao banco**.

- **API sem estado.** Nenhum dado de negócio fica na memória do processo entre requisições. Várias instâncias da API e o Worker compartilham o banco.
- **No Express/Fastify:** `store` e `orchestrator` apontam, via `AsyncLocalStorage`, para a unidade da requisição em curso; as rotas continuam síncronas. O `preHandler` abre a unidade e o `onSend` a confirma (ou desfaz se a resposta for ≥ 400). Cliente que desconecta no meio: `onRequestAbort` desfaz; o banco ainda encerra transações paradas por mais de 60 s.
- **Buscas anteriores à autenticação** (sessão, token de Runner, login por e-mail, identidade do Neon) usam 4 funções `SECURITY DEFINER` que devolvem só o registro pedido por uma chave secreta ou única. E-mail e identidade do Neon têm índice único global.
- **Sequência dos eventos** (`seq`) vive na própria execução (`eventSeq`), atualizada sob a trava: sem buracos nem repetição entre processos.
- **Eventos ao vivo.** O barramento (`EventBus`) é local, ou Redis pub/sub entre processos. O banco é a fonte da verdade: o SSE assina o canal, relê o passado, deduplica por `seq` e ainda consulta o banco a cada 10 s caso o Redis falhe.
- **RLS completo.** Leituras e escritas passam pelo papel restrito `command_ai_app` (sem BYPASSRLS) no contexto da organização: um erro de código que misture organizações é barrado pelo banco e a transação inteira é desfeita (teste).
- Tabelas `records` (JSONB por tipo, sempre com `organization_id`), `events` e `audit`, em schema próprio (`command_ai`, por `DB_SCHEMA`). Migrações SQL versionadas em `apps/api/migrations`, aplicadas pela conexão do dono.
- Valores entram como literais escapados pelo driver; o nome do schema é validado por expressão regular.

Em memória (`MemoryRepo`, para testes e demonstração) o mesmo código roda sobre um `Store` único, sem transações.

## Consequências

- **Custo por requisição proporcional ao tamanho da organização**: todos os registros dela são lidos a cada requisição autenticada (o painel consulta a cada poucos segundos). Para o volume do MVP é aceitável; **não foi medido**. Evolução natural: carregar só os tipos que a rota usa e índices por tipo.
- **Escritas serializadas por organização** (ver ADR 0001).
- **Limite de tentativas de login é por processo** (memória): com N instâncias, o limite efetivo é N vezes maior. Precisa ir para Redis ou banco.
- Registros são JSONB: o modelo normalizado com chaves estrangeiras e tipos fortes (Prisma) continua previsto para a etapa 5 do PRD.
- O dono do schema (`neondb_owner`) tem BYPASSRLS e fica só para migrações e para criar o papel.

## Revisão

Substituir `records` pelo modelo normalizado (Prisma) na etapa 5, medindo antes o custo do carregamento por requisição.
