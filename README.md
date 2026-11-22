# Command AI

Crie agentes de IA, delegue um objetivo e acompanhe, aprove e audite o trabalho em um só painel.
Implementação do [PRD v2.0](docs/PRD-status.md) (MVP vertical, etapas 1 a 3 em versão inicial).

Três formas de usar: **web**, **app instalável (PWA)** e **desktop (Electron)**. As três usam a mesma interface e o mesmo servidor.

## Estrutura

| Pasta | O que é |
| --- | --- |
| `apps/api` | Backend Fastify + Zod: autenticação, orquestrador, aprovações, eventos SSE, persistência no PostgreSQL (Neon) |
| `apps/web` | Painel React + Vite + Tailwind v4 (pt-BR e en, tema escuro por padrão, paleta Ctrl K) |
| `apps/runner` | Local Runner: único componente na máquina do usuário; só aceita trabalho assinado e diretórios autorizados |
| `apps/desktop` | Casca Electron que abre o painel numa janela própria e gera instaladores |
| `packages/shared` | Tipos, schemas Zod, máquina de estados, preços e assinatura de trabalhos |
| `docs/` | Arquitetura, segurança, operação e decisões (ADRs) |

## Rodar localmente

Requisitos: Node 22+ e pnpm 10 (`npm i -g pnpm`).

```powershell
pnpm install
pnpm test          # 343 testes (os de Postgres, Redis e Docker rodam contra serviços reais e são ignorados sem eles)
pnpm build
```

Banco e login (Neon): `neon deploy` já grava `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `NEON_AUTH_BASE_URL` e `NEON_AUTH_JWKS_URL` em `.env.local`.
Depois aplique o schema do app e crie o papel de banco restrito que a API usa em execução (RLS):

```powershell
pnpm db:migrate
pnpm --filter @command-ai/api run db:create-app-role   # grava DATABASE_URL_APP em .env.db-app
```

Sem `DATABASE_URL` (ou com `COMMAND_AI_STORAGE=memory`) a API roda só em memória, útil para demonstração (a recuperação de tarefas roda dentro da própria API).

Redis (fila de tempo e eventos ao vivo entre processos) e Worker de recuperação:

```powershell
docker compose up -d redis     # Redis em 127.0.0.1:6390, política noeviction
# defina REDIS_URL=redis://127.0.0.1:6390 no ambiente (ou em .env)
pnpm worker                    # processo de recuperação (sem porta); pode haver vários
```

Sem `REDIS_URL` tudo funciona: o Worker usa um relógio em processo e os eventos ao vivo valem só dentro de cada instância da API.

```powershell
pnpm dev           # API em :3011 e web em :5173 (proxy /api)
```

Para registrar um Runner: entre no painel, abra **Integrações**, crie o Runner e copie o token (aparece uma vez). Depois:

```powershell
$env:COMMAND_AI_RUNNER_TOKEN = "car_..."
$env:RUNNER_ALLOWED_WORKSPACES = "C:\caminho\do\projeto"
pnpm runner
```

Sem `ANTHROPIC_API_KEY` o Runner usa o executor simulado (não gasta tokens). Com a chave (`RUNNER_EXECUTOR=agent`) ele roda o **agente**: várias interações com o modelo, ferramentas de arquivo num worktree Git isolado, comandos só num contêiner Docker (imagem local, sem rede) e aprovação humana para operações críticas. O resultado vem como patch para você revisar; nada é aplicado à sua pasta. Detalhes, variáveis e limites em [docs/RUNBOOK.md](docs/RUNBOOK.md#agente-e-sandbox-runner) e [ADR 0005](docs/adr/0005-agente-e-sandbox.md).
Para ver o fluxo sem chave: `node apps/runner/scripts/e2e-agent.mjs` (modelo de demonstração, Docker local, 21 verificações).

## Web, PWA e desktop

- **Web:** `pnpm build` gera `apps/web/dist`. Se essa pasta existir, a API a serve na mesma origem (cookie `SameSite=Strict`, SSE e PWA funcionam sem CORS). Em produção rode só a API.
- **PWA:** abra o painel no Chrome ou Edge e use **Instalar no computador** (botão na barra lateral ou ícone na barra de endereço). Funciona em Windows, macOS e Linux. O service worker só guarda a casca do app; `/api` nunca entra em cache.
- **Desktop:** `pnpm desktop` abre a janela apontando para `http://127.0.0.1:3011`. Para outro servidor, defina `COMMAND_AI_URL` (https obrigatório fora de localhost) ou crie `config.json` com `{ "url": "https://..." }` na pasta de dados do app (menu **Command AI > Pasta de configuração**).
  Windows: `pnpm desktop:dist` gera `apps/desktop/dist/Command AI-<versão>-win.zip` (descompacte e abra `Command AI.exe`). O instalador `.exe` ainda não é gerado de forma confiável em máquinas com Smart App Control; ver [RUNBOOK](docs/RUNBOOK.md#pacote-e-instalador-desktop). Mac e Linux: `pnpm --filter @command-ai/desktop dist:mac` e `dist:linux`, cada um no seu sistema operacional. Nada é assinado; o Windows e o macOS avisam na primeira abertura até haver certificado.

## Status em relação ao PRD v2

Feito e testado:

- Login com senha (Argon2id, com migração automática de hashes antigos), MFA por aplicativo autenticador (TOTP) obrigatório em produção, anti-replay de código, sessões HttpOnly e limite de tentativas.
- Login pelo Neon Auth, trocado por uma sessão do painel.
- Organização em todo registro e isolamento entre organizações, com testes de acesso cruzado.
- Plano editável com validação de ciclos, dependências, aprovação humana para risco alto, novas tentativas com espera progressiva e parada por orçamento.
- **Confiabilidade (Fase 2):** API sem estado em memória, com várias instâncias sobre o mesmo PostgreSQL; reivindicação de tarefa atômica; lease com heartbeat e recuperação de tarefas de Runner que sumiu (Worker + BullMQ); prazo máximo de execução; relatórios idempotentes e com número da tentativa; cancelamento que chega ao Runner e o interrompe.
- **`Idempotency-Key`** nas criações de execução, agente, projeto e provedor: a mesma chave e o mesmo pedido devolvem a resposta guardada (cabeçalho `Idempotent-Replayed: true`), outro pedido com a mesma chave é recusado (422); vale por usuário, por 24 h, no máximo 500 por organização; o painel envia a chave sozinho. Criação de Runner fica de fora de propósito (a resposta tem o token).
- Eventos com número de sequência, replay por `Last-Event-ID` e reconexão sem perda, inclusive trocando de instância da API (Redis pub/sub + banco).
- Runner com trabalho assinado (HMAC), lista de diretórios autorizados e remoção de segredos nos logs.
- **Runner inteligente (Fase 3):** laço do agente com várias interações e ferramentas; guarda de caminhos (links, `.env`, `.git`, chaves); worktree Git isolado por tentativa e entrega por patch; comandos em contêiner Docker sem rede e com limites; política de risco com aprovação humana por chamada (apagar, rede, escrita direta); limites de turnos, tokens, tempo e custo; uso por interação no painel; cancelamento e orçamento que interrompem o agente. **Validado com um modelo roteirizado e um modelo de demonstração; nunca com o modelo real** (sem chave de API).
- Persistência em PostgreSQL (Neon) com migrações e RLS em toda leitura e escrita.
- Painel com Início orientado a ação, Nova execução, grafo ao vivo, fila de aprovações (A, R, J, K), agentes, projetos, integrações e administração.

Ainda não feito (previsto no PRD):

| Item | Situação |
| --- | --- |
| Motor durável (Temporal, Inngest, Restate) | A prova de conceito prevista no PRD não foi feita. O BullMQ cuida só da varredura de recuperação; a entrega de tarefas é atômica no PostgreSQL (ADR 0001) |
| Limite de tentativas de login compartilhado entre instâncias | Hoje é por processo (memória), então com N instâncias o limite efetivo é N vezes maior |
| Implantação do Worker e do Redis no Render | `pnpm worker` e o `docker-compose.yml` existem; a implantação **não foi testada** |
| Vazão e custo por requisição | Cada requisição carrega os registros da organização e as escritas são serializadas por organização. Não foi medido (ADR 0002) |
| Passkeys (WebAuthn), códigos de recuperação do MFA e login do Runner por código de dispositivo | Não implementados. O Runner usa token revogável |
| Modelo de dados normalizado (Prisma) | Hoje os registros ficam em JSONB por tipo, sempre com `organization_id` |
| Agente com o modelo real | Implementado e testado com respostas simuladas no formato da API; **a primeira execução com chave pode revelar ajustes** (esquemas estritos, autenticação do SDK, raciocínio entre turnos) |
| Orquestração multiagente (Fase 4), partes restantes | Feito: tarefas encadeadas (a seguinte parte do commit da anterior, resultados combinados, texto do upstream tratado como dado). Falta: agente que cria subtarefas e replaneja, comunicação entre agentes em andamento, execução paralela comprovada com vários Runners (o commit só existe no Runner que rodou a tarefa) |
| Sandbox mais forte que Docker comum (gVisor/Firecracker, imagem por digest) | Não implementado. O sandbox atual compartilha o kernel do Docker |
| Claude Agent SDK / Claude Code como executor | Não usado de propósito (ADR 0005): o laço é próprio, sobre o SDK da Messages API |
| Codex SDK, MCP, CLI `commandai`, Kanban, base de conhecimento, e-mail e Slack | Não implementados |
| Testes Playwright, Storybook, BoardUI | Sem testes automatizados do painel; componentes próprios em `components/ui.tsx` |
| Atualização automática do app desktop e assinatura de código | Não configuradas |

O Neon Auth gerenciado ainda não oferece MFA. Por isso, uma conta com MFA ativo no Command AI continua exigindo o código TOTP mesmo ao entrar pelo Neon Auth.
