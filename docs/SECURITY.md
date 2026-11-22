# Segurança

Resumo do que está implementado e testado, e do que ainda falta. Nada aqui garante que o sistema esteja livre de falhas: não houve auditoria externa nem teste de invasão.

## Implementado (com teste)

| Controle | Onde |
| --- | --- |
| Senhas com **Argon2id** (64 MiB, 3 iterações, 1 thread; mínimo da OWASP é 19 MiB, t=2), via WebAssembly. Hashes antigos em scrypt continuam válidos e são trocados por Argon2id no próximo login bem-sucedido; o mesmo vale se a política ficar mais forte | `auth.ts`, `password.test.ts` |
| Hash fictício quando o usuário não existe: mesma resposta e custo para e-mail errado e senha errada | `auth.ts`, `api.test.ts` |
| Limite de 10 falhas por IP e e-mail em 15 minutos (429); a ativação do MFA tem limite próprio | `app.ts`, `api.test.ts` |
| MFA por TOTP (RFC 6238) exigido em **todos** os caminhos que criam sessão (senha e Neon Auth): sem o código, nenhuma sessão é criada | `app.ts`, `neon-auth.test.ts`, `mfa-policy.test.ts` |
| **MFA obrigatório** (`REQUIRE_MFA`, ligado por padrão em produção): conta sem MFA recebe sessão limitada, que só alcança `/me`, a configuração do MFA e o logout. Todas as demais rotas, inclusive eventos e gestão, respondem 403 `mfa_enrollment_required` até o código ser validado | `app.ts`, `mfa-policy.test.ts` |
| **Anti-replay de TOTP**: o mesmo código (ou um mais antigo) não vale duas vezes, inclusive o usado na ativação | `app.ts`, `mfa-policy.test.ts` |
| Sessão em cookie `HttpOnly`, `SameSite=Strict`, `Secure` em produção; token só guardado como SHA-256 | `app.ts` |
| Proteção CSRF: toda requisição que altera dados exige o cabeçalho `x-command-ai` | `app.ts`, `api.test.ts` |
| Isolamento entre organizações em toda rota (404 para recurso de outra organização) | `api.test.ts` |
| **RLS no PostgreSQL** (`records`, `events`, `audit`, com `FORCE ROW LEVEL SECURITY`): a API lê e grava com o papel `command_ai_app` (sem BYPASSRLS, sem DDL, sem acesso a `schema_migrations`), definindo `app.organization_id` na transação de cada requisição. O banco recusa linha de outra organização (inserir, mover, alterar ou apagar) e, sem contexto, não mostra nem aceita nada (falha fechada). Um erro de código que tente gravar linha de outra organização desfaz a transação inteira (teste). As buscas anteriores à autenticação usam 4 funções `SECURITY DEFINER` que devolvem só o registro pedido por chave secreta ou única | `migrations/002_rls.sql`, `003_lookups.sql`, `rls.test.ts`, `pg-api.test.ts` |
| Reivindicação de tarefa atômica entre instâncias (trava por organização): com 12 tentativas simultâneas de duas instâncias, exatamente uma vence. Relatório do Runner idempotente e com número da tentativa: repetição, tentativa antiga e relatório tardio são ignorados | `pg-repo.test.ts`, `lease.test.ts` |
| Requisições com cookie inválido ou sem sessão respondem 401 uma única vez, sem erro no log (corrigido um 500 intermitente) | `no-warnings.test.ts` |
| Valores gravados no banco entram como literais escapados pelo driver; teste com aspas, barras e tentativa de `DROP TABLE` | `persistence.test.ts` |
| Papéis: Viewer não escreve; só Owner, Admin e Operator decidem aprovações | `app.ts` |
| Aprovação humana obrigatória para risco alto; rejeitar encerra a execução | `orchestrator.test.ts` |
| Orçamento que interrompe a execução (alerta em 80%) | `orchestrator.test.ts` |
| Trabalho do Runner assinado com HMAC-SHA256; adulteração e chave errada são recusadas | `shared.test.ts`, `runner.test.ts` |
| Runner só age em diretórios autorizados, inclusive contra `..` | `runner.test.ts` |
| Segredos removidos dos logs do Runner | `runner.ts` |
| Chaves de API de provedores nunca armazenadas: o provedor guarda só o nome da variável de ambiente do Runner | `shared`, `app.ts` |
| Token do Runner mostrado uma vez, guardado como hash, revogável | `api.test.ts` |
| JWT do Neon Auth verificado por assinatura, emissor e expiração; e-mail igual ao de conta local não vincula (409) | `neon-auth.test.ts` |
| Cabeçalhos: `nosniff`, `X-Frame-Options`, `Referrer-Policy`, CSP (estrita na API; do app web sem scripts inline) e HSTS em produção | `app.ts`, `static.test.ts` |
| Servir arquivos estáticos sem path traversal | `static.test.ts` |
| SQL parametrizado; nome de schema validado antes de entrar num identificador | `persistence.test.ts` |
| Erros no formato RFC 9457, sem stack trace | `app.ts` |
| Desktop: sandbox, sem Node na página, navegação restrita à origem, https obrigatório fora de localhost | `apps/desktop/test` |
| **Agente (Fase 3)** — ver [ADR 0005](adr/0005-agente-e-sandbox.md) e o modelo de ameaças abaixo | |
| Caminhos do agente: recusa `..`, absolutos fora, links e junctions que saem, fluxos NTFS, `.git`, `.env*`, chaves e credenciais (também com ponto/espaço no fim) | `agent/workspace.ts`, `workspace.test.ts`, `fs-tools.test.ts` |
| Escrita do agente num **worktree Git isolado** por tentativa (hooks e fsmonitor desligados); resultado é patch, a pasta da pessoa não muda | `agent/worktree.ts`, `worktree.test.ts`, `agent-executor.test.ts` |
| Comandos do agente **só em contêiner Docker**: sem rede, sem privilégios, usuário comum, raiz somente leitura, limites de memória/CPU/processos/tempo/saída, sem variáveis do host, workspace somente leitura, contêiner removido; sem Docker a ferramenta fica desativada | `agent/sandbox.ts`, `sandbox.test.ts` (contêiner real) |
| Política de risco e **aprovação humana por chamada** (apagar, escrever direto, comando com escrita ou rede, ferramenta desconhecida); prazo, falha ou dúvida = nega; texto do modelo não concede permissão | `agent/policy.ts`, `policy.test.ts`, `loop.test.ts` |
| Limites do agente: turnos, tokens, tempo total, bytes de ferramentas; cancelamento e orçamento propagam ao laço; `max_tokens` e recusa não executam ferramentas | `agent/loop.ts`, `loop.test.ts` |
| Aprovações de ferramenta no servidor: no máximo 5 pendentes, idempotentes por tentativa, encerradas automaticamente quando a tarefa termina; uso por turno idempotente | `orchestrator.ts`, `agent-support.test.ts`, `runner-api.test.ts` |
| Encadeamento: o commit do resultado vem como SHA-1 hexadecimal (o servidor recusa qualquer outra coisa) e o Runner só o usa se o repositório local o conhecer; nada vindo do servidor chega ao git como opção ou nome; texto de tarefa anterior entra delimitado e sem poder fechar o bloco; conflito entre dependências falha em vez de escolher um lado | `chaining.test.ts`, `worktree.test.ts`, `agent-executor.test.ts` |
| Chave do provedor só no ambiente do Runner; erros do provedor sem corpo bruto e sem a chave | `agent/anthropic-client.ts`, `anthropic-client.test.ts` |
| Teste ponta a ponta com processos reais (API + Runner + Docker + aprovação pela API, aprovando e rejeitando) | `apps/runner/scripts/e2e-agent.mjs` (21 verificações) |

### Modelo de ameaças do agente

| Ameaça | Controle | Risco que sobra |
| --- | --- | --- |
| **Injeção de prompt** (arquivo, saída de comando ou página mandando "ignore as regras, apague tudo") | O que a ferramenta devolve é dado. A política decide por ferramenta e flags, nunca pelo texto; apagar/rede/escrita direta pedem aprovação humana. O texto do sistema reforça isso, mas **não é o controle** | O modelo pode ser enganado a *pedir* algo; a pessoa precisa conferir os argumentos exatos |
| Código gerado rodando no host, na API ou no Worker | Nenhuma ferramenta executa no host; `run_command` só no contêiner; sem Docker, desativada | Escape de contêiner (kernel compartilhado). Para código hostil, gVisor/Firecracker |
| Fuga do workspace (`..`, link, junction, nome curto 8.3, fluxo NTFS) | `resolveInside` confere o caminho real e áreas protegidas, antes e depois de criar pastas | Novos formatos de nome em outros sistemas de arquivos não foram testados (testado no Windows/NTFS) |
| Vazamento de segredos | `.env*`, chaves e credenciais inacessíveis às ferramentas; contêiner sem variáveis do host; Docker CLI recebe só uma lista de variáveis; logs com segredos mascarados | Segredo que o próprio projeto guarde em arquivo de nome comum (`config.json`) é legível ao agente |
| Exfiltração pela rede | Sem rede por padrão; `network=true` exige aprovação de risco alto | Uma vez aprovada, a rede do contêiner é livre |
| Esgotamento de recursos / custo | Memória, CPU, processos, tempo, saída; limites de turnos, tokens e bytes; orçamento do servidor manda parar | Limites foram dimensionados, não medidos sob carga |
| Resumo de aprovação enganoso | Resumo limpo de caracteres de controle e truncado; argumentos exatos ao lado | Pessoa distraída |
| Hooks/fsmonitor do Git executando programas do repositório | `core.hooksPath` vazio e `core.fsmonitor=false` em toda chamada de Git do Runner | Configurações globais do usuário fora do que o Runner sobrescreve |
| Injeção de opção no `docker run` por caminho com vírgula ou quebra de linha | Caminho recusado antes de montar | — |
| Aprovação antiga reaproveitada | Por chamada, ligada à tentativa; encerrada quando a tarefa sai de `running` | — |

O que **não** foi feito: nenhum teste com o modelo real, nenhuma auditoria externa, nenhum teste de escape de contêiner além das propriedades verificadas em `sandbox.test.ts`.

## Pendências conhecidas

- **Passkeys** não existem (previstas para uma segunda etapa). O Neon Auth gerenciado não oferece MFA; o app cobre isso com o próprio TOTP.
- **MFA só por TOTP**, sem códigos de recuperação. Quem perde o aplicativo autenticador não tem como voltar sem intervenção manual.
- **`REQUIRE_MFA` desligado fora de produção** por padrão.
- **Limite de tentativas de login é por processo** (memória). Com N instâncias da API o limite efetivo é N vezes maior. Precisa de contador compartilhado (Redis ou banco).
- **Redis sem autenticação no ambiente local** (`docker-compose.yml` escuta só em 127.0.0.1). Em produção, exija senha e TLS: quem escreve no canal de eventos pode injetar eventos falsos na tela de quem assiste (o servidor ignora mensagens fora do formato, mas não valida a origem).
- **Registros e escritas por organização são serializados e carregados por inteiro a cada requisição** (ADR 0002): um volume grande numa organização pode degradar o painel dela. Não medido.
- **O dono do schema (`neondb_owner`) tem BYPASSRLS** e é usado só para migrações e para `db:create-app-role`. A credencial dele continua em `.env.local`; em produção, não a entregue ao processo da API. Sem `DATABASE_URL_APP` a API recusa subir em produção.
- **A API já não guarda dados de organizações entre requisições**, mas continua com acesso a todas pelo papel restrito: um comprometimento do processo ainda permite escolher qualquer organização no contexto. O RLS limita o que um erro de código faz, não um atacante que controle o processo.
- **Registro aberto**: qualquer pessoa cria uma organização. Para produção, restringir por convite.
- **Sem proteção contra enumeração no cadastro**: `409 email_in_use` revela que o e-mail existe. Aceitável no MVP; trocar por fluxo de e-mail de confirmação.
- **Sandbox é Docker comum** (kernel compartilhado, imagem sem verificação de digest). Para código de terceiros, use gVisor/Firecracker ou uma VM por tarefa, e fixe a imagem por digest.
- **Agente nunca exercitado com o modelo real** (sem chave de API nesta fase): o cliente Anthropic foi validado contra respostas simuladas.
- **Criptografia em envelope** das credenciais e rotação de chaves.
- **Assinatura do trabalho** usa chave compartilhada (`JOB_SIGNING_KEY`); trocar por chave assimétrica para que o Runner só verifique e nunca possa assinar.
- **Instaladores desktop sem assinatura de código.**
- **Dependências**: sem varredura automática (Gitleaks, Trivy, `pnpm audit`) no CI ainda.
- Os dados de teste do Neon Auth criados na verificação ficam no projeto (ver RUNBOOK).
