# ADR 0006: vários provedores de modelo

Status: aceita (Fase 5). Implementada e testada com respostas simuladas e com um servidor HTTP falso que fala o protocolo da OpenAI; **nunca exercitada contra OpenAI, DeepSeek ou Ollama de verdade** (sem chaves nem modelos instalados nesta máquina).

## Contexto

O agente (ADR 0005) falava só com a Anthropic. O produto promete orquestrar agentes de empresas diferentes (Claude, Codex/OpenAI, DeepSeek, modelos locais). O laço do agente já dependia de uma interface (`ModelClient`), então o trabalho era dar a ela outras implementações sem mexer em política, aprovação, sandbox, limites nem no servidor.

## Decisão

1. **Um cliente para o protocolo Chat Completions** (`openai-client.ts`), usado por três tipos de provedor: `openai`, `deepseek` e `ollama` (que expõe `/v1/chat/completions`). A Anthropic continua com o SDK oficial. O cliente usa `fetch` direto (API pequena e estável, sem mais uma dependência com acesso à chave), com tentativas para 429/5xx/rede, prazo, cancelamento e mensagens de erro sem corpo bruto e sem a chave.
2. **Tradução, não vazamento de detalhes do provedor para o laço.** Ferramentas viram `function`; resultados viram mensagens `role=tool` (sem `is_error` na API, o erro vai no texto com prefixo `ERRO:`); `finish_reason` vira o mesmo vocabulário de parada (`length`→`max_tokens`, `content_filter`→recusa); uso com cache vem de `cached_tokens` (OpenAI) ou `prompt_cache_hit_tokens` (DeepSeek); argumentos que não são JSON viram entrada inválida que o Runner recusa e o modelo corrige. O esquema das ferramentas é o mesmo da Anthropic (`schema.ts`), sem `strict` (nem todo servidor aceita); a validação local de cada entrada continua sendo o controle.
3. **Quem escolhe o provedor é o agente; quem guarda a chave é o Runner.** O trabalho assinado leva só o **tipo** (`provider`). O Runner lê a chave de uma variável **fixa por tipo** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`) e o endereço de variáveis do próprio Runner (`OPENAI_BASE_URL`, `DEEPSEEK_BASE_URL`, `OLLAMA_BASE_URL`), só aceitando URLs http(s). O servidor **não** escolhe nome de variável nem URL: se escolhesse, um servidor comprometido faria o Runner enviar qualquer variável do ambiente (por exemplo uma conexão de banco) como `Authorization` a um terceiro. O `apiKeyRef` do cadastro de provedores é só informativo.
4. **O mesmo laço, a mesma segurança.** Política, aprovação humana, sandbox, worktree, limites, subtarefas e mensagens funcionam igual com qualquer provedor, porque ficam acima do `ModelClient`.

## Consequências e limites

- **Custo desconhecido para modelos fora da tabela de preços.** Não inventei preços de OpenAI, DeepSeek nem de modelos locais. Nesses casos a execução marca `costUnknown` e **o orçamento em dinheiro não consegue parar a execução**; continuam valendo os limites do Runner (turnos, tokens, tempo, bytes). Para ter orçamento efetivo é preciso cadastrar o preço do modelo (próximo passo possível).
- **Qualidade de chamada de ferramentas varia muito entre modelos**, sobretudo locais. O Runner valida tudo e devolve o erro ao modelo, mas um modelo fraco pode girar até o limite de turnos.
- **Raciocínio entre turnos**: campos como `reasoning_content` (DeepSeek) são descartados ao reenviar a mensagem. Alguns modelos de raciocínio com ferramentas podem exigir que voltem; não foi verificado.
- **Sem streaming** neste cliente (resposta inteira por chamada).
- **Dados saem da máquina para o provedor escolhido.** Código lido pelo agente vai para a OpenAI ou DeepSeek se o agente usar esses provedores; com Ollama local, não. A pessoa decide por agente.
- Servidores "compatíveis" têm diferenças (campos de uso ausentes, `stop` com `tool_calls`); o cliente tolera os casos conhecidos.

## Revisão

Reavaliar na primeira execução real com cada provedor, ao cadastrar preços por modelo, e se algum provedor passar a exigir streaming ou outra API (por exemplo Responses).
