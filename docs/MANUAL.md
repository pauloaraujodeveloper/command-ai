# Manual do Command AI

Um guia simples para usar o sistema e ligar as suas IAs a ele. Não precisa saber programar para seguir os passos; onde aparece um comando, é só copiar e colar no PowerShell.

---

## 1. O que é o Command AI

É um painel onde você **pede um trabalho** e uma **equipe de IAs** o executa. Cada IA é um "agente". Você acompanha tudo ao vivo e decide o que pode ou não ser feito.

Duas ideias importam:

- **Nada é aplicado ao seu projeto sem você ver.** Os agentes trabalham numa cópia isolada da sua pasta e entregam o resultado como um *patch* (um pacote de mudanças). Você revisa e só então aplica.
- **Coisas importantes pedem a sua aprovação.** Rodar comandos, apagar arquivos ou dividir o trabalho em partes aparece em **Aprovações**, e só continua se você aprovar.

### As peças do sistema

| Peça | O que faz | Onde fica |
|---|---|---|
| **Painel** (web, app instalado ou desktop) | A tela que você usa | Na nuvem (Render) |
| **Banco de dados** | Guarda contas, projetos, agentes e histórico | Neon |
| **Runner** | É quem de fato **executa** os agentes, usando as suas IAs | **No seu computador** |

Por isso o Runner roda na sua máquina: é lá que estão a sua pasta de projeto, o seu Claude Code logado e as suas chaves. **Suas chaves e o código do seu projeto não vão para o servidor.**

---

## 2. Primeiro acesso

1. Abra o endereço do sistema (o do Render, algo como `https://command-ai-xxxx.onrender.com`).
2. Clique em **Criar conta** e use o e-mail autorizado e uma senha sua, com **12 ou mais caracteres**. Você vira o **dono** (`owner`), o papel que pode tudo.
3. O sistema pede para ativar o **MFA** (segundo fator). Instale um app autenticador no celular (Google Authenticator, Authy, Microsoft Authenticator), leia o código que aparece e digite o número de 6 dígitos. Em **Administração** você pode ver e refazer isso depois.
4. A partir daí, para entrar você usa e-mail, senha e o código do app.

> **Guarde a senha** no seu gerenciador de senhas. Não existe "esqueci minha senha" por e-mail por enquanto.

Se o servidor estiver num plano que hiberna, o primeiro acesso do dia pode levar alguns segundos para acordar.

### Instalar como aplicativo

- **No computador (PWA):** abra o painel no Chrome ou no Edge e clique em **Instalar no computador** (botão na barra lateral ou ícone na barra de endereço).
- **Desktop (Windows):** use o pacote `Command AI-0.1.0-win.zip`. Descompacte, abra `Command AI.exe` e aponte para o servidor (veja o fim deste manual). O Windows pode avisar que o app não é assinado: clique em **Mais informações** e depois em **Executar assim mesmo**.
- **Celular:** abra o endereço no navegador e use **Adicionar à tela inicial**.

---

## 3. Conectando as suas IAs

Esta é a parte principal. Existem **dois tipos** de conexão:

- **Por assinatura:** você usa o plano que já paga (Claude, ChatGPT). **Sem chave de API, sem cobrança por uso.**
- **Por chave de API:** você usa uma chave do provedor. Paga por uso.

| Quero usar | Como entra | Precisa de |
|---|---|---|
| **Claude** (plano Pro/Max) | Provedor `claude_code` | Claude Code instalado e logado |
| **ChatGPT / Codex** (plano pago) | Provedor `codex` | Codex instalado e logado |
| **Claude por API** | Provedor `anthropic` | Chave `ANTHROPIC_API_KEY` |
| **OpenAI por API** | Provedor `openai` | Chave `OPENAI_API_KEY` |
| **DeepSeek por API** | Provedor `deepseek` | Chave `DEEPSEEK_API_KEY` |
| **Modelo local** (grátis, nada sai do PC) | Provedor `ollama` | Ollama instalado |
| **Só para testar** | Provedor `simulated` | Nada |

Pode misturar: cada agente escolhe o seu provedor. Um agente pode usar o Claude e outro o Codex.

### Passo A: preparar o Runner (uma vez só)

O Runner é o programa que roda na sua máquina e executa os agentes.

**O que precisa estar instalado:**

- **Node 22 ou mais novo** e **pnpm** (`npm i -g pnpm`).
- **Git** (os agentes trabalham sobre o Git do seu projeto).
- **Docker** *(opcional, mas recomendado)*: é onde os comandos dos agentes rodam, isolados do seu computador. Sem Docker, os agentes ainda leem e editam arquivos, mas não executam comandos.
- A pasta do projeto do Command AI, com `pnpm install` já feito.

Se for usar comandos, baixe uma vez a imagem do sandbox (o Runner nunca baixa nada sozinho):

```powershell
docker pull node:22-alpine
```

### Passo B: registrar o Runner no painel

1. No painel, abra **Integrações**.
2. Em **Runners**, clique em **Registrar Runner**, dê um nome (por exemplo, "meu-pc") e confirme.
3. Aparece um **token** que começa com `car_`. **Ele só aparece uma vez**: copie agora e guarde.

### Passo C: iniciar o Runner

Na pasta do projeto do Command AI, no PowerShell:

```powershell
$env:COMMAND_AI_API_URL = "https://SEU-ENDERECO.onrender.com"
$env:COMMAND_AI_RUNNER_TOKEN = "car_cole_o_token_aqui"
$env:RUNNER_ALLOWED_WORKSPACES = "C:\caminho\do\seu\projeto"
$env:RUNNER_EXECUTOR = "agent"
pnpm runner
```

- `RUNNER_ALLOWED_WORKSPACES` é a lista de pastas onde os agentes **podem** trabalhar. Fora dela, nada é tocado. Para mais de uma pasta, separe com `;`.
- Na partida, o Runner mostra um resumo do que está configurado (provedores, Docker, login do Codex). **Ele nunca mostra suas chaves.**
- No painel, em **Integrações**, o Runner passa a aparecer como **Online**.

Deixe essa janela aberta enquanto os agentes trabalham.

### Passo D: conectar cada IA

#### Claude (pelo seu plano, sem chave)

1. Instale o Claude Code e entre com a sua conta (`claude` no terminal, uma vez, e faça o login).
2. Pronto. O Runner usa essa sessão automaticamente.
3. Ao criar o agente (Passo E), escolha o provedor **`claude_code`** e o modelo `haiku`, `sonnet` ou `opus`.

Pontos de atenção:
- O uso sai da **cota do seu plano**. Se ela acabar, a tarefa falha com a mensagem do Claude. O painel mostra o custo como zero, mas **o orçamento em dinheiro não protege a cota do plano**.
- Para ver se está tudo certo, rode (gasta um pouco da cota): `cd apps/runner` e depois `npx tsx scripts/live-claude-check.ts`.

#### ChatGPT / Codex (pelo seu plano)

Precisa de um plano do ChatGPT que **inclua o Codex** (o plano gratuito não serve).

1. Instale: `npm i -g @openai/codex`
2. Entre: `codex login`. Abre o navegador; pode entrar com a conta do ChatGPT (inclusive "Continuar com Google" se a conta foi criada assim).
3. Ao criar o agente, escolha o provedor **`codex`** (modelo `default` usa o da sua conta).

> **Importante:** o suporte ao Codex foi construído e testado com um programa de mentira, mas **ainda não foi verificado com um login real**. Trate como experimental até rodar `npx tsx scripts/live-codex-check.ts` (em `apps/runner`) com sucesso.

#### Claude, OpenAI ou DeepSeek por chave de API

Defina a chave **na janela onde o Runner roda**, antes de iniciá-lo. A chave fica só na sua máquina:

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
$env:OPENAI_API_KEY    = "sk-..."
$env:DEEPSEEK_API_KEY  = "..."
```

Defina só as que for usar. O nome da variável é fixo e o Runner a procura sozinho. **Nunca** cole chaves em arquivos do projeto nem em conversas.

Atenção ao custo: o painel só sabe calcular preço dos modelos da Anthropic. Com os outros, o custo aparece como "indisponível" e o limite em dinheiro **não para a execução**; valem os limites de turnos, tokens e tempo.

#### Modelo local (Ollama)

Instale o Ollama e baixe um modelo. Não precisa de chave e **nada sai do seu computador**. Ao criar o agente, escolha `ollama` e o nome do modelo.

### Passo E: criar os agentes

Abra **Agentes**.

**Jeito rápido: equipe pronta.** Clique em **Criar time de software**, escolha o provedor e o modelo, e o sistema cria 5 agentes ligados entre si:

- **Orquestrador:** lê o projeto, divide o trabalho e distribui. Só lê, não altera arquivos.
- **Front-end:** telas. Só altera as pastas de interface.
- **Back-end:** API. Só altera as pastas do servidor.
- **Banco de dados:** só altera migrações e SQL.
- **Infraestrutura:** só altera Docker, deploy e CI.

Cada especialista tem um **escopo**: ele só pode escrever nos lugares da sua área. Se tentar escrever fora, é recusado.

**Jeito manual.** Clique em **Novo agente** e preencha:

- **Nome** e **Função**: o que ele é.
- **Instruções**: como deve trabalhar.
- **Provedor** e **Modelo**: qual IA ele usa (veja a tabela da seção 3).
- **Orçamento por execução**: um teto em dólares (só vale para os modelos que têm preço conhecido).

Para ajustar um agente existente, clique no **lápis** ao lado dele. Lá você muda o escopo, as responsabilidades e do que ele depende.

### Passo F: cadastrar o projeto

Abra **Projetos** e clique em **Novo projeto**:

- **Nome**.
- **Caminho do workspace:** a pasta do projeto no seu computador (por exemplo, `C:\Users\voce\meu-site`). Ela precisa estar dentro das pastas liberadas no `RUNNER_ALLOWED_WORKSPACES`. **No app desktop** há o botão **Escolher pasta**, que abre a janela do Windows para você selecionar a pasta. No navegador e no PWA não há esse botão (limite de segurança do navegador): copie o caminho no Explorador de Arquivos e cole no campo.
- A pasta precisa ser um **repositório Git com pelo menos um commit**. Sem isso, os agentes só conseguem ler.

**PRD (descrição do projeto):** em **Editar PRD**, cole um texto explicando o que o sistema é e o que deve fazer. O orquestrador recebe o texto completo e cada especialista, a parte que importa para ele. Quanto melhor o PRD, melhor o trabalho.

---

## 4. Usando no dia a dia

### Pedir um trabalho

1. Abra **Nova execução**.
2. Escreva o **Objetivo** com clareza: o que fazer, onde e como saber que ficou bom.
3. Escolha o **Projeto** e o **Agente** (para uma equipe, escolha o orquestrador).
4. Defina o **Orçamento** e clique em **Gerar plano**.
5. Revise o plano. Você pode editar as tarefas, adicionar outras e ver a estimativa de tempo e custo.
6. Clique em **Aprovar e iniciar**.

### Acompanhar ao vivo

Em **Execuções**, abra a execução:

- **Grafo de execução:** as tarefas e quem depende de quem.
- **Linha do tempo:** tudo o que acontece, incluindo as mensagens entre agentes.
- **Agentes** (botão no topo): o desenho da equipe, com o estado e as tarefas de cada um. Clique num agente para filtrar a linha do tempo só por ele.
- **Cancelar execução** para parar tudo.

Você vê "Ao vivo" quando a conexão está ativa.

### Aprovar o que pede a sua decisão

A tela **Aprovações** (e o aviso em **Início**) mostra o que está esperando você. Cada pedido mostra o que o agente quer fazer, o risco e os detalhes exatos. **Aprovar vale só para aquela ação.** Se você não responder a tempo, o sistema nega.

Quando o orquestrador quer dividir o trabalho entre os especialistas, aparece uma aprovação com os títulos das tarefas. Ao aprovar, as tarefas novas entram no grafo.

### Receber o resultado

Ao terminar, o resultado traz um **patch**. Revise e, se estiver bom, aplique no seu projeto:

```powershell
git apply "C:\caminho\do\arquivo.patch"
```

Os patches ficam salvos na pasta de dados do Runner (por padrão, `~\.command-ai-runner\patches`).

### Página Início

Mostra o que precisa de você, o que está em andamento, as concluídas e as falhas das últimas 24 h, e o custo.

---

## 5. Papéis das pessoas

Quem cria a conta no servidor vira `owner`. Outros papéis:

| Papel | Pode |
|---|---|
| `owner` | Tudo |
| `admin` | Quase tudo, com administração e aprovações |
| `operator` | Criar, executar e aprovar |
| `developer` | Criar e editar, mas **não** aprovar nem administrar |
| `viewer` | Só ver |

---

## 6. Usando o app desktop com o servidor na nuvem

Por padrão, o app desktop abre `http://127.0.0.1:3011` (uma API na sua própria máquina). Para usar o servidor do Render:

- Defina a variável `COMMAND_AI_URL` com o endereço (precisa ser `https`), **ou**
- No menu do app, **Command AI > Pasta de configuração**, crie o arquivo `config.json` com:

```json
{ "url": "https://SEU-ENDERECO.onrender.com" }
```

A conta é a mesma em todos os lugares (web, app instalado, desktop e celular).

---

## 7. Se algo não funcionar

| Sintoma | O que fazer |
|---|---|
| "Não foi possível conectar ao servidor" | O servidor está fora do ar ou hibernando. Espere um minuto e clique em **Tentar de novo**. No app desktop, confira o endereço (seção 6) |
| "O cadastro está fechado neste servidor" | O e-mail não está na lista de autorizados. Peça ao dono do servidor para incluí-lo |
| Runner aparece **Offline** | A janela do Runner foi fechada ou o token/endereço está errado. Rode o Passo C de novo |
| A execução não anda | Veja **Aprovações**: provavelmente algo espera a sua decisão |
| "Sandbox de comandos: INDISPONÍVEL" na partida do Runner | O Docker não está aberto, ou a imagem não foi baixada (`docker pull node:22-alpine`). Os agentes seguem lendo e editando arquivos, mas sem rodar comandos |
| Agente do Claude falha dizendo que a cota acabou | O plano chegou ao limite. Espere renovar ou use outro agente/provedor |
| Agente só lê e não escreve | A pasta não é um repositório Git com commit, ou o escopo do agente não cobre aquela pasta |
| Agente diz que escrever é "fora do escopo" | Está funcionando como deve. Ajuste o escopo do agente (lápis em **Agentes**) se a área realmente for dele |
| Custo "indisponível" | Normal para modelos que não são da Anthropic. Os limites de turnos, tokens e tempo continuam valendo |

Para sair de dúvidas rápidas, o endereço `/api/v1/health` do servidor deve responder `{"status":"ok"}`.

---

## 8. Cuidados de segurança

- **Nunca** cole chaves de API, tokens ou senhas em chats, e-mails ou arquivos do projeto.
- O token do Runner dá acesso para executar trabalho na sua conta. Se vazar, vá em **Integrações** e clique em **Revogar**, depois registre um novo.
- Deixe o **MFA** sempre ligado.
- Mantenha `RUNNER_ALLOWED_WORKSPACES` com **só** as pastas necessárias.
- Revise o patch antes de aplicar. Nada é aplicado sozinho.
- Em **Administração** há a **trilha de auditoria**: quem fez o quê e quando.

---

## 9. Glossário

- **Agente:** uma IA com função, instruções e limites próprios.
- **Orquestrador:** o agente que planeja e distribui o trabalho entre os outros.
- **Especialista:** agente de uma área (front-end, back-end, banco, infra).
- **Runner:** o programa na sua máquina que executa os agentes.
- **Provedor:** de onde vem a IA (Claude, Codex, OpenAI, Ollama...).
- **Escopo:** os lugares onde um agente pode escrever.
- **Execução:** um pedido de trabalho e tudo o que ele gera.
- **Patch:** o pacote de mudanças que você revisa e aplica.
- **PRD:** o texto que descreve o projeto.
- **MFA:** o código de 6 dígitos do app autenticador, além da senha.
- **Sandbox:** o ambiente isolado (Docker) onde os comandos dos agentes rodam.

---

## Estado atual (seja realista)

- Testado com modelo real: **Claude Code** (equipe completa, com o modelo haiku, num cenário pequeno).
- **Codex:** implementado, mas ainda sem teste real com login.
- **OpenAI, DeepSeek e Ollama:** implementados e testados com simulações, sem teste real com chave.
- Os escopos padrão da equipe são um ponto de partida; ajuste ao seu projeto.
- O app desktop não é assinado e não se atualiza sozinho.
