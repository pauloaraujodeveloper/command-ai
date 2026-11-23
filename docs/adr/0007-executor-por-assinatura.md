# ADR 0007: executor que usa a assinatura (Claude Code) em vez de chave de API

Status: aceita. Claude Code implementado e **verificado com o CLI real** (2.1.314, duas execuções mínimas nesta máquina). Codex **não implementado**: o CLI não está instalado e eu não escrevo código contra flags que não consigo conferir.

## Contexto

Quem usa o Command AI pode ter apenas assinatura mensal (Claude Pro/Max, ChatGPT Plus/Pro), que não inclui chave de API. O ADR 0006 exige chave. A forma legítima de usar a assinatura de forma programática é acionar a ferramenta oficial já autenticada na máquina (`claude -p`, `codex exec`): o Command AI **nunca vê, copia nem envia o token da assinatura**.

## Decisão

1. **Um executor que roda o CLI como processo filho** (`claude-code.ts`), escolhido pelo tipo de provedor `claude_code` do agente. O resto do sistema (worktree, patch, commit encadeado, uso, cancelamento, heartbeat, log) é o mesmo do agente por API.
2. **Isolamento por capacidade, verificado no CLI real.** O CLI roda com `--restricted` (remove Bash/PowerShell e outras ferramentas que executam código, remove WebFetch, ignora configurações de usuário/projeto, **confina as ferramentas de arquivo ao diretório de trabalho**), `--tools Read,Write,Edit,Glob,Grep`, `--allowedTools Write,Edit` (só no worktree), `--permission-mode dontAsk` e `--permission-prompts none` (o que pediria permissão é negado), `--strict-mcp-config` (sem MCP), `--no-session-persistence` e `--disable-slash-commands`. O diretório de trabalho é o **worktree isolado** da tarefa. Teste real: escrita dentro do diretório funcionou; escrita fora foi recusada pelo próprio CLI (`--restricted confines the file tools…`) e o arquivo não existe.
3. **Sem shell não há comando para aprovar.** A regra "operações críticas passam por aprovação humana" é cumprida removendo a capacidade: o agente por CLI não executa comandos, não apaga arquivos (não há ferramenta de exclusão), não usa rede e não cria subtarefas nem mensagens. Se quisermos isso depois, entra por um servidor MCP próprio do Runner, com a mesma política do agente por API.
4. **Ambiente do filho por lista de permitidos.** Só variáveis necessárias para o CLI achar o login (PATH, perfil do usuário, pastas temporárias). **Nada** do ambiente do Runner passa: nem o token do Runner, nem a chave de assinatura de trabalhos, nem URLs de banco, nem chaves de outros provedores. `ANTHROPIC_API_KEY` é removida de propósito: se existisse, o CLI cobraria da API em vez de usar a assinatura.
5. **O prompt vai por stdin**, não por argumento (sem limite de tamanho da linha de comando, sem aparecer na lista de processos). Resultados de tarefas anteriores e mensagens continuam entrando como dado não confiável, delimitado.
6. **Limites e parada:** tempo máximo (mata a árvore de processos), cancelamento do servidor (heartbeat) e teto de saída. Não há `--max-turns` nesta versão do CLI; o limite é o tempo.
7. **Custo e cota.** Na assinatura não há custo por token: o uso é registrado com o modelo `assinatura`, preço zero. O orçamento em dinheiro **não** protege a cota da assinatura. O CLI informa o "custo equivalente de API", que vai para o log só como referência. Se a cota acabar, o CLI devolve erro e a tarefa falha com a mensagem dele.

## O que foi verificado no CLI real

`scripts/live-claude-check.ts` rodou o executor de ponta a ponta com o Claude Code 2.1.314: leu arquivos, criou `NOTAS.md` no worktree (patch e commit entregues), a pasta original ficou intacta, só ferramentas de arquivo foram usadas e o uso (incluindo cache) foi relatado. Antes, duas execuções mínimas confirmaram o comportamento do `--restricted` (escrita fora do diretório recusada pelo CLI). O CLI emite `rate_limit_event` com `utilization` e `resetsAt`; o executor mostra isso no log (na primeira verificação o plano estava em 97% da cota semanal).

## Consequências e limites

- **O processo roda na sua máquina, com o seu usuário, sem contêiner.** A proteção é a lista de ferramentas e a confinação de arquivos do próprio CLI, não um isolamento de kernel. Um defeito no CLI ou na confinação (por exemplo links simbólicos no repositório) seria um escape; o worktree reduz o dano, não elimina. Rodar o CLI dentro do Docker exigiria entregar a credencial ao contêiner (o agente poderia lê-la): não fazemos.
- **Menos capacidade que o agente por API**: sem comandos (testes, build), sem subtarefas, sem mensagens, sem aprovação por chamada.
- **Dependência da forma como o CLI se comporta** (flags e formato `stream-json`). Mudanças de versão podem quebrar; o executor valida o formato, trata linhas desconhecidas como informação e falha com mensagem clara se não vier o evento final.
- **Termos de uso:** acionar o CLI oficial logado, para o seu próprio trabalho, é o uso previsto; revender ou compartilhar a assinatura por esse caminho não é. Confira os termos do seu plano.
- **Codex:** quando o CLI estiver instalado, o mesmo contrato vale: worktree como diretório, sandbox próprio do Codex em modo de escrita no workspace, sem aprovação interativa, ambiente filtrado, prompt por stdin, saída em JSON. Falta conferir `codex exec --help` e o comportamento do sandbox no Windows (o suporte nativo é recente).

## Revisão

Reavaliar a cada atualização maior do CLI, ao instalar o Codex, e se a Anthropic ou a OpenAI mudarem os termos para uso programático das assinaturas.
