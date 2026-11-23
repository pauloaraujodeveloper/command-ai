# ADR 0008 — Equipe hierárquica de agentes

Status: aceito.

## Contexto

Um único agente executava o plano inteiro. Queremos uma equipe como no diagrama de orquestração: o pedido chega a um **orquestrador** que conhece o projeto e o PRD, delega a **especialistas** (front-end, back-end, banco de dados, infraestrutura), todos se comunicam, e cada um sabe o que pode e o que não pode fazer e do que depende.

## Decisão

- **Modelo.** `Agent` ganhou `kind` (`orchestrator` | `specialist`), `domain`, `parentAgentId` (até 4 níveis, sem ciclo, domínio único entre irmãos), `responsibilities`, `writeScopes` e `dependsOnDomains`. O PRD fica em `Project.context` (até 100 mil caracteres).
- **Delegação.** `plan_subtasks` aceita `agent` (domínio ou nome). Dentro de uma hierarquia, cada agente só delega a si mesmo e aos descendentes; o servidor valida e devolve 404 com a lista de agentes disponíveis, ou 422 quando o nome é ambíguo. A criação de subtarefas continua passando por aprovação humana.
- **Escopo de escrita em três camadas**, porque um prompt não é controle: (1) as ferramentas de arquivo do Runner recusam caminhos fora do escopo; (2) `finalize` do worktree recusa o resultado (`ScopeError`, sem commit nem referência) se algo fora do escopo mudou; (3) os executores por assinatura (Claude Code, Codex) também passam por `finalize`. Ausente = sem restrição; `[]` = somente leitura. Padrões sem regex (`**` atravessa pastas; padrão sem `/` vale só na raiz; sem diferenciar maiúsculas), para evitar retrocesso catastrófico.
- **Contexto.** O orquestrador recebe o PRD inteiro (até 60 mil caracteres); o especialista, um trecho (até 12 mil) com `projectContextTruncated`. O PRD entra delimitado e rotulado como dado, não como instrução. O prompt de papel (`role.ts`) diz ao agente o que pode alterar, o que não pode, de quem depende e quem são os colegas.
- **Visão.** `packages/shared/src/hierarchy.ts` calcula níveis, colunas, arestas (delegação, dependência, resultado), estado por agente e mensagens enviadas/recebidas, tolerando dados ruins (pai apagado, ciclo). A tela Equipe e a execução desenham o mesmo modelo (`HierarchyChart`). Estado por ícone, texto e cor, nunca só cor.
- **Time pronto.** `packages/shared/src/team.ts` define o time de software (orquestrador somente leitura e quatro especialistas com escopos e dependências iniciais). A tela cria os agentes pela API normal, sem endpoint novo.

## Consequências e limites

- **Os escopos padrão são um chute razoável**, não conhecem o seu projeto: ajuste-os. Um escopo largo demais não protege; estreito demais faz o agente pedir ajuda a quem não pode.
- **O escopo vale para o que o Runner enxerga.** Comandos no sandbox escrevem no worktree e são conferidos pelo `finalize`; mas um escopo não impede que um agente *leia* tudo (somente leitura não esconde segredos; a filtragem de `.env` e segredos continua sendo a de antes).
- **Dependência entre domínios é orientação, não trava.** `dependsOnDomains` aparece no prompt e no gráfico; a ordem real vem do `dependsOn` das tarefas que o orquestrador declara.
- **A inteligência da delegação depende do modelo.** Verificado de ponta a ponta com processos reais só com o modelo de demonstração (roteiro fixo): `node apps/runner/scripts/e2e-team.mjs` (20 verificações). Um modelo de verdade pode delegar mal, ignorar o escopo (será recusado) ou não conversar; isso ainda não foi medido.
- Apagar agente com filhos ou com uso é recusado (409); não há migração automática de filhos.
