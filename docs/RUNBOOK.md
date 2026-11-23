# Operação

## Variáveis de ambiente

| Variável | Quem usa | Observação |
| --- | --- | --- |
| `DATABASE_URL` | API | Conexão com pooler (`-pooler`). Gerada por `neon env pull` em `.env.local` |
| `DATABASE_URL_UNPOOLED` | migrações, `db:create-app-role` | Conexão direta, como dono do schema (ignora RLS) |
| `DATABASE_URL_APP` | API | Papel restrito `command_ai_app` (RLS valendo), com pooler. Gerada por `db:create-app-role` em `.env.db-app` (fora do Git). Sem ela a API recusa subir em produção |
| `ALLOW_DB_WITHOUT_RLS=true` | API | Permite subir em produção com o dono do schema. Não recomendado |
| `DB_APP_ROLE` | `db:create-app-role` | Nome do papel; padrão `command_ai_app` |
| `DB_SCHEMA` | API, migrações | Padrão `command_ai` |
| `NEON_AUTH_BASE_URL`, `NEON_AUTH_JWKS_URL` | API, web | Ativam o login pelo Neon Auth. A web só recebe a URL (pública) |
| `JOB_SIGNING_KEY` | API, Runner | Obrigatório em produção, mínimo de 32 caracteres |
| `REQUIRE_MFA` | API | `true` exige MFA de todas as contas (sessão limitada até ativar). Padrão: `true` em produção, `false` fora dela |
| `PORT`, `HOST` | API | Padrão `3011` e `127.0.0.1` |
| `WEB_DIST` | API | Pasta do build web; padrão `../web/dist` |
| `COMMAND_AI_STORAGE=memory` | API | Ignora o banco (demonstração) |
| `REDIS_URL` | API, Worker | Ativa BullMQ (Worker), eventos ao vivo e o **limite de tentativas de login compartilhado** entre processos. Sem ela: relógio em processo e eventos só na própria instância. Em produção use autenticação e TLS (`rediss://`) e `maxmemory-policy noeviction` |
| `LEASE_MS` | API, Worker | Quanto tempo uma tarefa vive sem heartbeat (padrão 60000). O Runner bate a cada um terço. **API e Worker precisam do mesmo valor** |
| `BACKOFF_BASE_MS`, `BACKOFF_MAX_MS` | API, Worker | Espera entre tentativas: base × 2^(n-1) até o teto (padrão 5000 e 300000) |
| `MAX_EXECUTION_MS` | API, Worker | Prazo máximo de uma execução em andamento (padrão 7200000, 2 h) |
| `SWEEP_INTERVAL_MS` | Worker | Intervalo da varredura de recuperação (padrão 15000) |
| `SWEEP_IN_PROCESS=true` | API | Roda a varredura dentro da API, para quem não tem Worker separado. Em memória já vem ligado |
| `COMMAND_AI_RUNNER_TOKEN`, `RUNNER_ALLOWED_WORKSPACES`, `COMMAND_AI_API_URL`, `ANTHROPIC_API_KEY` | Runner | Sem a chave, usa o executor simulado |
| `RUNNER_CODEX_BIN` | Runner | Caminho do Codex: `codex.js` (roda pelo Node), `.exe`, nunca `.cmd`. Padrão: o Runner acha o `codex.js` do pacote npm global ao lado do shim no PATH |
| `RUNNER_CLAUDE_BIN` | Runner | Caminho do executável do Claude Code (padrão `claude` no PATH). Agentes do provedor `claude_code` usam a assinatura do plano logado nesta máquina, sem chave |
| `OPENAI_API_KEY`, `DEEPSEEK_API_KEY` | Runner | Chaves dos agentes dos provedores `openai` e `deepseek`. O nome da variável é fixo: o servidor não escolhe qual variável o Runner lê |
| `OPENAI_BASE_URL`, `DEEPSEEK_BASE_URL`, `OLLAMA_BASE_URL` | Runner | Endereço da API (padrões `https://api.openai.com/v1`, `https://api.deepseek.com`, `http://127.0.0.1:11434/v1`). Só http ou https. Serve também para servidores compatíveis (vLLM, LM Studio…) |
| `RUNNER_EXECUTOR` | Runner | `agent` (modelo real; padrão se houver chave), `agent-demo` (roteiro fixo, sem chave, para testar o fluxo) ou `simulated` (padrão sem chave) |
| `RUNNER_SANDBOX_IMAGE` | Runner | Imagem Docker dos comandos do agente (padrão `node:22-alpine`). **Precisa existir localmente** (`docker pull`); o Runner não baixa nada |
| `RUNNER_SANDBOX=off` | Runner | Desliga o sandbox: a ferramenta `run_command` some (comandos nunca rodam no host) |
| `RUNNER_SANDBOX_MEMORY`, `RUNNER_SANDBOX_CPUS`, `RUNNER_SANDBOX_PIDS` | Runner | Limites do contêiner (padrão `512m`, `1`, `128`) |
| `RUNNER_DATA_DIR` | Runner | Onde ficam worktrees e patches (padrão `~/.command-ai-runner`) |
| `RUNNER_DEMO_MESSAGES=1` | Runner | Só com `RUNNER_EXECUTOR=agent-demo`: a análise manda um aviso para a revisão, que o registra num arquivo (para ver a conversa entre agentes sem chave) |
| `RUNNER_DEMO_SUBTASKS=1` | Runner | Só com `RUNNER_EXECUTOR=agent-demo`: a tarefa de análise delega duas subtarefas encadeadas (para ver o fluxo sem chave) |
| `RUNNER_ALLOW_DIRECT_WRITES=1` | Runner | Pasta sem Git passa a aceitar escrita direta (cada escrita pede aprovação). Padrão: somente leitura |
| `RUNNER_MAX_TURNS`, `RUNNER_MAX_TOTAL_TOKENS`, `RUNNER_TASK_TIMEOUT_MS`, `RUNNER_MAX_TOKENS_PER_TURN`, `RUNNER_MAX_TOOL_OUTPUT_BYTES` | Runner | Limites do agente (padrão 25 turnos, 500000 tokens, 30 min, 8192 por turno, 2 MB) |
| `RUNNER_COMMAND_TIMEOUT_MS`, `RUNNER_APPROVAL_TIMEOUT_MS`, `RUNNER_APPROVAL_POLL_MS` | Runner | Teto de um comando (300000), espera por aprovação humana antes de negar (900000) e intervalo de consulta (2000) |
| `COMMAND_AI_URL` | Desktop | URL do servidor; https fora de localhost |

`.env.local` e `.env` ficam fora do Git.

## Banco (Neon)

```powershell
neon deploy         # aplica neon.ts (Postgres + Auth) e atualiza .env.local
pnpm db:migrate     # cria/atualiza o schema do app (idempotente)
```

- Migrações usam a conexão direta (dono do schema); o app usa a com pooler **e o papel restrito**.
- Criar o papel e conceder acesso: `pnpm --filter @command-ai/api run db:create-app-role`. É idempotente (reaplica as permissões) e **não troca a senha** se `.env.db-app` já existe; use `-- --rotate` para gerar uma nova (depois reinicie a API).
- Depois de criar tabelas novas por migração, rode `db:create-app-role` de novo para conceder acesso a elas.
- Para conferir o isolamento à mão: conecte com `DATABASE_URL_APP` e rode `SELECT count(*) FROM command_ai.records;` — sem `SET`/`set_config('app.organization_id', ...)` o resultado é 0.
- Para testar uma migração, crie uma branch (`neon checkout dev --create`), migre nela e só depois aplique em produção.
- Os testes de persistência criam um schema `ca_test_*` temporário no banco configurado e o apagam no fim. Sem credenciais, esses testes são ignorados.

## Redis e Worker

```powershell
docker compose up -d redis      # Redis local em 127.0.0.1:6390 (noeviction, AOF ligado)
pnpm worker                     # processo de recuperação; defina REDIS_URL para usar BullMQ
```

- Pode haver vários Workers e várias APIs. Cada ciclo de varredura roda uma vez no total, e a trava por organização impede conflito.
- **Se o Redis cair:** nenhuma tarefa se perde (a entrega é no PostgreSQL). A varredura e os eventos ao vivo ficam parados até ele voltar; o painel ainda recebe eventos pelo SSE, que consulta o banco a cada 10 s.
- **Se o Worker cair:** tarefas de Runners que sumiram ficam em `running` até um Worker voltar. Ao subir, o Worker faz uma varredura imediata e as devolve à fila.
- **Se uma API cair:** nada se perde (o estado está no banco). O painel reconecta em outra instância com `Last-Event-ID` e recebe o que faltou.
- **Se um Runner sumir:** o lease vence (`LEASE_MS`), a varredura devolve a tarefa à fila com espera, e outro Runner a refaz. Um relatório tardio do Runner antigo é ignorado.
- Para limpar o Redis de desenvolvimento: `docker exec command-ai-redis redis-cli flushall` (o contêiner é só deste projeto).

## Agente e sandbox (Runner)

```powershell
docker pull node:22-alpine                                  # decisão sua: o Runner nunca baixa imagens
$env:RUNNER_EXECUTOR = 'agent'; $env:ANTHROPIC_API_KEY = '...'; pnpm runner
```

- **O que o agente faz:** lê e escreve num **worktree Git isolado** (fora do seu repositório) e entrega um **patch** no resultado e em `RUNNER_DATA_DIR/patches/`. Para aplicar depois de revisar: `git apply "<arquivo.patch>"`. Worktrees com mudanças ficam para revisão; sem mudanças, são removidos. Pasta sem Git (ou sem commit) é somente leitura.
- **Aprovações de ferramenta** aparecem em *Aprovações* (e na fila de atenção) com a ferramenta, o resumo, o risco e os argumentos exatos. Aprovar vale só para aquela chamada. Sem decisão em `RUNNER_APPROVAL_TIMEOUT_MS`, a chamada é negada.
- **Sem Docker ou sem a imagem:** o Runner avisa na partida (`Sandbox de comandos: INDISPONÍVEL…`) e a ferramenta `run_command` não é oferecida. Nada roda no host.
- **Assinatura (Claude Code):** crie um agente com provedor `claude_code` e modelo `haiku`, `sonnet`, `opus` (ou um nome completo). O Runner aciona o `claude` já logado, **sem chave**, confinado ao worktree: ler, escrever e editar arquivos pelas ferramentas do próprio CLI (sem shell nem rede próprios). **Comandos, apagar arquivo, subtarefas e mensagens vêm das ferramentas do Runner por um servidor MCP local** (porta aleatória em 127.0.0.1, com token por tarefa), com a mesma política e as mesmas aprovações do agente por API (as aprovações aparecem em *Aprovações*); sem Docker/imagem local, comandos não existem. O uso entra no painel como modelo `assinatura`, custo zero; **o orçamento em dinheiro não protege a cota do plano**. O log mostra o aviso de cota do plano (porcentagem usada e quando renova). Se a cota acabar, a tarefa falha com a mensagem do CLI. Verificação real (usa um pouco da cota): `cd apps/runner; npx tsx scripts/live-claude-check.ts` (arquivos) e `npx tsx scripts/live-claude-mcp-check.ts` (comandos no sandbox, precisa do Docker e de uma imagem local). **Codex ainda não** (CLI não instalado: ADR 0007).
- **Assinatura ChatGPT (Codex):** `npm i -g @openai/codex` e **`codex login`** (só você faz; abre o navegador). Depois crie um agente com provedor `codex` (modelo `default` usa o da conta). Mesmas garantias do Claude Code: worktree, ambiente do filho filtrado, shell próprio do Codex desligado, comandos/apagar/subtarefas/mensagens pelas ferramentas do Runner (MCP local, mesma aprovação humana), alarmes que matam o Codex se ele tentar shell próprio, web, outro MCP ou arquivo fora do worktree. **Ainda não verificado com login:** rode `cd apps/runner; npx tsx scripts/live-codex-check.ts` e me mostre a saída; até lá trate o executor como não validado. Na partida o Runner mostra a versão e o estado do login.
- **Vários provedores:** cada agente tem um provedor (`anthropic`, `openai`, `deepseek`, `ollama`); o Runner usa o cliente certo e a chave do próprio ambiente. Na partida ele lista o que está configurado (sem mostrar chaves). **Custo:** só há preços na tabela para os modelos da Anthropic; com outros modelos a execução mostra custo desconhecido e **o orçamento em dinheiro não para a execução** (valem os limites de turnos, tokens e tempo). Dados lidos pelo agente vão ao provedor escolhido; com `ollama` local nada sai da máquina.
- **Subtarefas:** quando o agente pede `plan_subtasks`, aparece uma aprovação com os títulos; ao aprovar, o plano cresce e o grafo mostra as tarefas novas. Limites: 5 por chamada, 25 tarefas e geração 2 por execução. Uma tarefa recusada pelo servidor (limite, id repetido) devolve o motivo ao agente.
- **Mensagens entre agentes:** cada mensagem aparece na linha do tempo ("Mensagem de X para Y") e o texto completo está em `GET /api/v1/executions/<id>/messages`. Limites: 2000 caracteres e 20 mensagens por tarefa; não se envia para tarefa já encerrada.
- **Referências do encadeamento:** cada tarefa concluída deixa `refs/command-ai/<tarefa>-a<tentativa>` no seu repositório (o branch não muda). Para ver: `git for-each-ref refs/command-ai`. Para apagar todas: `git for-each-ref --format='%(refname)' refs/command-ai | ForEach-Object { git update-ref -d $_ }` e depois `git gc`.
- **Limpeza:** `docker ps -a --filter name=ca-sbx-` deve estar vazio fora de uma execução. Worktrees esquecidos: `git worktree list` no repositório e `git worktree prune`.
- **Verificar com o modelo real** (gasta tokens, pouco: teto de 60 mil tokens e modelo mais barato por padrão; roda num repositório temporário, sem Docker e sem a API do Command AI). Confere autenticação, esquemas estritos de todas as ferramentas, `plan_subtasks` com lista de objetos e um laço de várias interações com raciocínio reenviado:

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."   # só nesta janela do PowerShell, nunca em arquivo
cd apps/runner
npx tsx scripts/live-model-check.ts       # LIVE_MODEL escolhe o modelo (padrão claude-haiku-5-5)
```

- **Verificar tudo de ponta a ponta sem chave de API** (usa o modelo de demonstração, o Docker local e uma API em memória):

```powershell
cd apps/runner
node scripts/e2e-agent.mjs                  # 43 verificações; E2E_SANDBOX_IMAGE escolhe a imagem local (padrão redis:7-alpine)
node scripts/demo-pending-approval.mjs      # sobe o painel em http://127.0.0.1:3097 com uma aprovação de ferramenta pendente
```

## Equipe hierárquica

- **Criar a equipe:** tela Agentes → “Criar time de software” (orquestrador somente leitura + front-end, back-end, banco, infra). Depois ajuste domínio, responsabilidades, “onde pode alterar arquivos” e dependências ao seu projeto (a edição é o lápis ao lado de cada agente).
- **PRD:** tela Projetos → “Editar PRD” (Markdown, até 100 mil caracteres). O orquestrador recebe tudo; cada especialista, um trecho.
- **Escopo de escrita:** um padrão por linha (`apps/web/**`; `**` atravessa pastas; sem barra vale só na raiz). Escrever fora é recusado na ferramenta e, de novo, ao concluir a tarefa (o resultado não é aceito). “Somente leitura” = lista vazia.
- **Ver a hierarquia:** tela Agentes (estrutura) e a execução, aba “Agentes” (estado por agente, tarefas, dependências e mensagens). Clique num agente para filtrar a linha do tempo.
- **Teste sem chave:** `node apps/runner/scripts/e2e-team.mjs` (Docker local; `RUNNER_DEMO_TEAM=1` usa o roteiro fixo da equipe).

## Idempotency-Key

POST de `/executions`, `/agents`, `/projects` e `/providers` aceita `Idempotency-Key` (8 a 128 caracteres: letras, números, `_ . : -`). Repetir a mesma chave com o mesmo corpo devolve a resposta original; o corpo diferente ou outra rota devolve 422 `idempotency_key_reuse`. As respostas ficam guardadas por 24 h (registro `idempotency` no banco, no máximo 500 por organização). Falhas (4xx/5xx) não são guardadas, então repetir depois de um erro executa de novo.

## Encerramento e reinício

Cada requisição confirma a própria transação antes de responder; não há fila de gravação em segundo plano. `SIGTERM` e `SIGINT` terminam as requisições em curso e fecham o pool; um `kill -9` no meio de uma requisição descarta só a transação daquela requisição (o banco a desfaz), nunca grava pela metade.
O Worker, ao receber `SIGTERM`, termina a varredura em curso (cada organização confirma a própria transação) antes de sair.

## Dados de teste criados na verificação do Neon

A verificação ponta a ponta criou **3 usuários de teste** no Neon Auth do projeto, todos com e-mail `ca-verify-*@example.com` ou `ca-ui-verify-*@example.com`. Remova-os pelo Console da Neon (Auth > Users). Os schemas temporários do banco já foram apagados; só existe `command_ai` (vazio).

## Turborepo bloqueado pelo Windows

Os scripts da raiz usam `pnpm -r` (respeita a ordem entre pacotes). `turbo.json` continua configurado e `pnpm turbo:build` e `pnpm turbo:test` o usam.

**Causa (confirmada no log `Microsoft-Windows-CodeIntegrity/Operational`, eventos 3033 e 3077):** uma política de integridade de código do Windows (Smart App Control / App Control, Policy ID `{0283ac0f-fff1-49ae-ada1-8a933130cad6}`) bloqueia executáveis sem assinatura confiável, como o `turbo.exe` do npm. Não é o Defender nem o Firewall: desativá-los não muda nada, e não recomendamos fazê-lo. Para ver o bloqueio:

```powershell
Get-WinEvent -LogName 'Microsoft-Windows-CodeIntegrity/Operational' -MaxEvents 30 | Where-Object Id -in 3033,3077
```

Opções: continuar com `pnpm -r` (o padrão), rodar o Turbo em CI ou outra máquina, ou desligar o Smart App Control (decisão sua; no Windows 11 isso **não pode ser revertido** sem reinstalar o sistema).

## Pacote e instalador desktop

`pnpm desktop:dist` constrói o painel e gera `apps/desktop/dist/Command AI-<versão>-win.zip` (descompacte e abra `Command AI.exe`). O Electron já vem assinado, então roda mesmo com a política ativa.

O instalador `.exe` (`pnpm --filter @command-ai/desktop dist:win:installer`) **falha nesta máquina** com `spawn UNKNOWN`: para criar o desinstalador, o `electron-builder` executa o próprio instalador recém-gerado, que não tem assinatura, e a mesma política o bloqueia (evento 3077 no `Command AI Setup 0.1.0.exe`). Uma vez ele pareceu funcionar, mas isso não é confiável e **não deve ser tratado como resolvido**. Para ter um instalador de verdade:

1. Assine com um certificado de assinatura de código confiável (`CSC_LINK` e `CSC_KEY_PASSWORD`), ou
2. Gere o instalador em CI (por exemplo, runner `windows-latest` do GitHub Actions), onde essa política não existe.

Em qualquer caso, teste instalação, atualização e desinstalação em uma máquina limpa. Isso ainda **não foi feito**. Se um `.exe` de poucas centenas de KB aparecer em `dist/`, é resíduo de uma compilação que falhou: apague a pasta `dist/`.
