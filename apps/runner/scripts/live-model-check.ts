// Verificação com o MODELO REAL (gasta tokens de verdade, mas pouco: teto de 60 mil tokens, modelo mais barato por padrão).
// Roda tudo na sua máquina, num repositório temporário; a chave nunca é impressa nem enviada a outro lugar além da API da Anthropic.
//
//   $env:ANTHROPIC_API_KEY = "sk-ant-..."      # só nesta janela do PowerShell
//   cd apps/runner; npx tsx scripts/live-model-check.ts
//
// Variáveis: LIVE_MODEL (padrão claude-haiku-5-5). Não usa Docker nem a API do Command AI.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { costFor, PRICING } from '@command-ai/shared';
import { AnthropicModelClient } from '../src/agent/anthropic-client.ts';
import { runAgent, buildSystemPrompt } from '../src/agent/loop.ts';
import { toolSpecs, validateInput, TOOLS } from '../src/agent/tools.ts';
import { createTaskWorkspace } from '../src/agent/worktree.ts';
import type { TurnUsage } from '../src/agent/types.ts';

const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.error('Defina ANTHROPIC_API_KEY nesta janela do PowerShell antes de rodar (veja o topo deste arquivo).');
  process.exit(2);
}
const MODEL = process.env.LIVE_MODEL ?? 'claude-haiku-5-5';
const model = new AnthropicModelClient({ apiKey: key, model: MODEL, maxRetries: 2 });
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
const total: TurnUsage = { model: MODEL, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const add = (u: TurnUsage) => {
  total.inputTokens += u.inputTokens;
  total.outputTokens += u.outputTokens;
  total.cacheReadTokens = (total.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0);
  total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + (u.cacheWriteTokens ?? 0);
};
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK   ' : 'FALHA'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const signal = new AbortController().signal;

console.log(`Modelo: ${MODEL} (preço conhecido: ${PRICING[MODEL] ? 'sim' : 'NÃO: o custo sairá como desconhecido'})`);

/* 1 ---- chamada simples: autenticação, formato da resposta, uso */
try {
  const t = await model.turn({ system: 'Responda em uma frase curta.', messages: [{ role: 'user', content: 'Diga olá em português.' }], tools: [], maxTokens: 400, signal });
  add(t.usage);
  check('1. chamada simples: autenticação e resposta', t.text.trim().length > 0 && t.stopReason === 'end_turn', `${t.usage.inputTokens} in / ${t.usage.outputTokens} out`);
} catch (e) {
  check('1. chamada simples: autenticação e resposta', false, e instanceof Error ? e.message : String(e));
  console.log('\nSem uma chamada simples funcionando, o resto não faz sentido. Confira a chave e o nome do modelo.');
  process.exit(1);
}

/* 2 ---- todas as ferramentas (esquemas estritos, listas, enum) são aceitas pela API e o modelo chama uma com entrada válida */
try {
  const tools = toolSpecs('worktree', { sandbox: true, planning: true, messaging: true });
  const t = await model.turn({
    system: 'Você é um agente. Use as ferramentas quando pedido.',
    messages: [{ role: 'user', content: 'Chame a ferramenta list_dir com path ".". Não escreva mais nada.' }],
    tools,
    maxTokens: 600,
    signal,
  });
  add(t.usage);
  const c = t.toolCalls[0];
  const spec = c ? tools.find((x) => x.name === c.name) : undefined;
  const invalid = c && spec ? validateInput(spec, c.input) : 'sem chamada';
  check(`2. ${tools.length} ferramentas em modo estrito aceitas e chamada válida`, t.stopReason === 'tool_use' && c?.name === 'list_dir' && invalid === null, `${c?.name ?? 'nenhuma'}${invalid ? ` (${invalid})` : ''}`);
} catch (e) {
  check('2. ferramentas em modo estrito aceitas pela API', false, e instanceof Error ? e.message : String(e));
}

/* 3 ---- o modelo monta uma chamada de plan_subtasks (lista de objetos) que o Runner aceita */
try {
  const tools = toolSpecs('worktree', { planning: true });
  const t = await model.turn({
    system: 'Você é um agente. Use as ferramentas quando pedido.',
    messages: [{ role: 'user', content: 'Use plan_subtasks para criar duas subtarefas: "docs" (escrever a documentação) e "testes" (escrever os testes, depende de "docs"). Não faça mais nada.' }],
    tools,
    maxTokens: 800,
    signal,
  });
  add(t.usage);
  const c = t.toolCalls.find((x) => x.name === 'plan_subtasks');
  const invalid = c ? validateInput(TOOLS.plan_subtasks!.spec, c.input) : 'sem chamada';
  check('3. plan_subtasks (lista de objetos) chamada com entrada válida', !!c && invalid === null, invalid ?? '');
} catch (e) {
  check('3. plan_subtasks', false, e instanceof Error ? e.message : String(e));
}

/* 4 ---- laço completo, várias interações, num worktree isolado (raciocínio reenviado, resultados de ferramentas, patch) */
const base = mkdtempSync(join(tmpdir(), 'ca-live-'));
try {
  const repo = join(base, 'repo');
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=live', '-c', 'user.email=live@example.com', ...a], { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# Calculadora\nUma biblioteca pequena com soma e subtração.\n');
  writeFileSync(join(repo, 'calc.js'), 'export const soma = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const ws = await createTaskWorkspace({ workspacePath: repo, taskId: 'live:t1', attempt: 1, dataDir: join(base, 'dados') });
  const sent: string[] = [];
  const result = await runAgent({
    model,
    workspace: { root: ws.root, kind: ws.kind },
    client: {
      usage: async () => ({ applied: true, cancel: false }),
      requestApproval: async () => ({ approvalId: 'x' }),
      approvalStatus: async () => ({ status: 'rejected', reason: 'verificação automática: nada exige aprovação aqui' }),
      addSubtasks: async () => ({ added: [] }),
      sendMessage: async (_t, b) => (sent.push(b.to), { id: 'm' }),
      readMessages: async () => ({ messages: [] }),
    },
    taskId: 'live:t1',
    attempt: 1,
    system: buildSystemPrompt('Você documenta projetos pequenos.'),
    prompt: 'Liste os arquivos, leia o README.md e o calc.js e crie o arquivo NOTAS.md com um resumo de duas linhas do projeto. Depois responda com uma frase dizendo o que fez.',
    emit: (l) => console.log(`   · ${l}`),
    signal,
    limits: { maxTurns: 8, maxTotalTokens: 60_000, timeoutMs: 120_000, maxTokensPerTurn: 2_000, maxToolOutputBytes: 100_000, approvalPollMs: 50, approvalTimeoutMs: 1_000 },
  });
  add(result.totalUsage);
  const fin = await ws.finalize();
  check('4. laço completo com o modelo real (várias interações, ferramentas, raciocínio reenviado)', result.turns >= 2 && result.output.trim().length > 0, `${result.turns} interações`);
  check('4b. o agente criou NOTAS.md num worktree isolado e a pasta original não mudou', fin.changedFiles >= 1 && /NOTAS\.md/.test(fin.stat) && git('status', '--porcelain').toString().trim() === '', fin.stat.split('\n')[0] ?? '');
  try {
    console.log(`   · NOTAS.md: ${readFileSync(join(ws.root, 'NOTAS.md'), 'utf8').trim().slice(0, 200).replace(/\n/g, ' ⏎ ')}`);
  } catch {
    /* sem arquivo: a verificação acima já falhou */
  }
  await ws.cleanup();
} catch (e) {
  check('4. laço completo com o modelo real', false, e instanceof Error ? e.message : String(e));
} finally {
  rmSync(base, { recursive: true, force: true });
}

/* ---- resumo ---- */
const cost = costFor(MODEL, total, PRICING);
console.log(`\nUso total: ${total.inputTokens} entrada, ${total.outputTokens} saída, ${total.cacheReadTokens} lidos do cache, ${total.cacheWriteTokens} gravados no cache`);
console.log(`Custo estimado: ${cost === null ? 'desconhecido (modelo fora da tabela de preços)' : `US$ ${cost.toFixed(4)}`}`);
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} verificações passaram`);
process.exit(failed.length ? 1 : 0);
