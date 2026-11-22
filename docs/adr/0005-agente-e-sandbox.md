# ADR 0005: agente com ferramentas, aprovação humana e sandbox

Status: aceita (Fase 3). Implementada e testada com modelo roteirizado; **não testada com o modelo real** (não havia chave de API).

## Contexto

Até a Fase 2 o Runner fazia uma única chamada ao modelo. A Fase 3 pede um agente de verdade: várias interações, uso de ferramentas, análise dos resultados, aprovação humana de operações críticas, controle de tempo, tokens e custo, cancelamento e isolamento. A regra do usuário é inegociável: **código gerado por IA nunca roda no processo da API nem do Worker**; só em ambiente isolado, com permissões e limites.

## Decisão

1. **Laço próprio sobre a Messages API** (`apps/runner/src/agent/loop.ts`, SDK oficial `@anthropic-ai/sdk`). O laço é nosso para que cada chamada de ferramenta passe pela nossa política, pela nossa aprovação e pelos nossos limites. O conteúdo do assistente (inclusive blocos de raciocínio) é reenviado intacto; `stop_reason` é tratado (`tool_use`, `end_turn`, `max_tokens`, `refusal`, `pause_turn`); ferramentas em modo estrito, cache automático do prefixo.
2. **O Runner é o único lugar onde o agente age.** A API e o Worker só recebem relatos (log, uso por turno, pedidos de aprovação, resultado).
3. **Seis ferramentas** (`tools.ts`): `list_dir`, `read_file`, `search_files`, `write_file`, `edit_file`, `delete_file`, mais `run_command`. Toda entrada é validada contra o esquema antes de executar; erro vira `tool_result` de erro para o modelo corrigir.
4. **Arquivos**: todo caminho passa por `resolveInside` (`workspace.ts`): recusa `..`, caminho absoluto fora, link simbólico ou junction que aponte para fora (confere o caminho real), fluxos alternativos do NTFS, e áreas protegidas (`.git`, `.ssh`, `.aws`, `.gnupg`, `.env*`, `*.pem`, `*.key`, `id_*`, `.npmrc` etc., inclusive com ponto ou espaço no fim).
5. **Escrita isolada por padrão** (`worktree.ts`): repositório Git com commit vira um **worktree solto por tentativa**, fora do repositório (pasta de dados do Runner). Hooks e `fsmonitor` do Git desligados. O resultado é um **patch para revisão**; nada é aplicado à pasta da pessoa. Pasta sem Git é **somente leitura**, salvo `RUNNER_ALLOW_DIRECT_WRITES=1` (e então cada escrita pede aprovação).
6. **Comandos só no sandbox** (`sandbox.ts`): contêiner Docker descartável por comando — sem rede, `--cap-drop ALL`, `no-new-privileges`, usuário 1000, raiz somente leitura, `/tmp` de 64 MB em memória, memória, CPU e processos limitados, tempo máximo, saída limitada, nenhuma variável do host, workspace montado somente leitura. Sem Docker ou sem a imagem local, `run_command` **fica desativada**; nunca há alternativa no host. A imagem não é baixada automaticamente.
7. **Política e aprovação** (`policy.ts`): leitura passa; escrita no worktree passa; apagar arquivo, escrever direto, comando com escrita no workspace (médio), comando com rede (alto) e ferramenta desconhecida (alto) exigem **aprovação humana por chamada**. A política olha só a ferramenta, o tipo de workspace e as flags: **texto do modelo ou de arquivos nunca concede permissão**. Sem decisão no prazo, falha ao registrar o pedido, ou pedido encerrado: **nega**. Rejeição não derruba a tarefa: o modelo recebe o motivo e segue.
8. **Controle**: máximo de turnos, de tokens, de tempo total (inclui esperar aprovação) e de bytes devolvidos por ferramentas. Cada interação relata seu uso à API (idempotente por `turn`); a resposta traz `cancel` (cancelamento ou orçamento estourado) e o laço para. Uso que não conseguiu ser relatado segue no relatório final.
9. **Monitoramento**: cada passo vira linha de log (workspace, sandbox, ferramenta, resultado ok/erro, aprovação, uso e custo por turno) na linha do tempo da execução.

## Alternativas

- **Claude Agent SDK / Claude Code como subprocesso**: traz um conjunto grande de ferramentas (inclusive shell no host) e uma política de permissões que não controlamos o suficiente. Rejeitado para esta fase.
- **Tool runner beta do SDK**: esconde o laço; precisaríamos do mesmo controle por chamada.
- **Rodar comandos no host com lista de permitidos**: lista de comandos não é isolamento. Rejeitado.
- **gVisor/Firecracker**: isolamento mais forte que Docker comum; fica como evolução (ver limites).

## Consequências e limites (honestos)

- **Docker compartilha o kernel** (no Windows, o da VM do WSL2). Escape de contêiner é raro, mas não impossível; para código realmente hostil, a próxima camada é gVisor/Firecracker ou uma VM por tarefa. Quem controla o daemon Docker já tem poder de administrador da máquina.
- **A imagem do sandbox é confiança de cadeia de suprimentos**: use uma imagem que você mesmo baixou e fixou por digest.
- **Não validado com o modelo real**: o cliente Anthropic foi testado contra respostas SSE simuladas no formato da API (mapeamento, esquemas estritos sem limites numéricos, erros, cancelamento), não contra a API. Pontos a observar na primeira execução real: aceitação dos esquemas estritos, cabeçalho de autenticação do SDK 1.x, comportamento do raciocínio entre turnos.
- **Encadeamento (Fase 4, primeira parte)**: o resultado de cada tarefa vira um commit numa referência `refs/command-ai/*` do repositório (nunca no branch da pessoa) e as tarefas dependentes partem dele; com duas ou mais dependências os resultados são combinados por merge, e conflito falha a tarefa com mensagem clara. O texto produzido por uma tarefa chega à seguinte como dado delimitado e rotulado como não confiável. O commit só existe na máquina do Runner que executou a tarefa: se outro Runner pegar a dependente, ele não o encontra e parte do HEAD (com aviso no log). As referências ficam no repositório até serem apagadas (ver RUNBOOK).
- **Sem ferramenta de Git, de rede ou de instalação de pacotes além do que o `run_command` permite** (e rede exige aprovação alta).
- O resumo da aprovação é montado pelo Runner, limpo de caracteres de controle; os **argumentos exatos** vão ao lado para a pessoa conferir. Um humano distraído ainda pode aprovar algo ruim: o desenho reduz o dano (por chamada, com prazo), não o elimina.

## Revisão

Reavaliar quando houver execução com o modelo real, quando a Fase 4 trouxer comunicação entre agentes, e antes de oferecer o Runner a terceiros (assinatura de trabalho assimétrica, imagem fixada por digest, gVisor).
