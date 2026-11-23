#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SignedJob } from '@command-ai/shared/signing';
import { demoModel } from './agent/demo-model.ts';
import { agentExecutor } from './agent/executor.ts';
import { createModelFor, providerCheck } from './agent/providers.ts';
import { DockerSandbox, probeDocker, type Sandbox } from './agent/sandbox.ts';
import { claudeCodeExecutor } from './agent/claude-code.ts';
import { codexExecutor, resolveCodexCommand } from './agent/codex-cli.ts';
import { routeExecutor } from './agent/route.ts';
import { simulatedExecutor } from './executors.ts';
import { processNextJob, type RunnerClient } from './runner.ts';

try {
  process.loadEnvFile(resolve(process.cwd(), '../../.env'));
} catch {
  /* sem .env */
}

const apiUrl = (process.env.COMMAND_AI_API_URL ?? 'http://127.0.0.1:3011').replace(/\/$/, '');
const token = process.env.COMMAND_AI_RUNNER_TOKEN ?? '';
const signingKey = process.env.JOB_SIGNING_KEY ?? 'dev-only-signing-key-change-me-000000000000';
const allowedWorkspaces = (process.env.RUNNER_ALLOWED_WORKSPACES ?? '')
  .split(/[;,]/)
  .map((s) => s.trim())
  .filter(Boolean);
const pollMs = Number(process.env.RUNNER_POLL_MS ?? 2000);

if (!token) {
  console.error('Defina COMMAND_AI_RUNNER_TOKEN (crie um Runner em Integrações no painel).');
  process.exit(1);
}
if (allowedWorkspaces.length === 0) {
  console.error('Defina RUNNER_ALLOWED_WORKSPACES com os diretórios que o Runner pode usar (separados por ; ou ,).');
  process.exit(1);
}

const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

async function call(path: string, body?: unknown): Promise<Response> {
  return fetch(`${apiUrl}/api/v1/runner${path}`, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
}

const client: RunnerClient = {
  async claim() {
    const res = await call('/claim');
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`claim falhou: ${res.status}`);
    return ((await res.json()) as { job: SignedJob }).job;
  },
  async log(taskId, line) {
    await call(`/tasks/${encodeURIComponent(taskId)}/log`, { line });
  },
  async heartbeat(taskId) {
    const res = await call(`/tasks/${encodeURIComponent(taskId)}/heartbeat`, {});
    if (!res.ok) throw new Error(`heartbeat falhou: ${res.status}`);
    return (await res.json()) as { ok: boolean; cancel: boolean };
  },
  async usage(taskId, body) {
    const res = await call(`/tasks/${encodeURIComponent(taskId)}/usage`, body);
    if (!res.ok) throw new Error(`usage falhou: ${res.status}`);
    const r = (await res.json()) as { applied: boolean; cancel: boolean };
    return { applied: r.applied, cancel: r.cancel };
  },
  async sendMessage(taskId, body) {
    const res = await call(`/tasks/${encodeURIComponent(taskId)}/messages`, body);
    if (!res.ok) {
      const p = (await res.json().catch(() => null)) as { detail?: string } | null;
      throw new Error(`${p?.detail ?? 'recusado'} (HTTP ${res.status})`.slice(0, 400));
    }
    return (await res.json()) as { id: string };
  },
  async readMessages(taskId, body) {
    const res = await call(`/tasks/${encodeURIComponent(taskId)}/messages/read`, body);
    if (!res.ok) {
      const p = (await res.json().catch(() => null)) as { detail?: string } | null;
      throw new Error(`${p?.detail ?? 'recusado'} (HTTP ${res.status})`.slice(0, 400));
    }
    return (await res.json()) as { messages: Array<{ id?: string; from: string; fromTitle: string; content: string; at: string }> };
  },
  async addSubtasks(taskId, body) {
    const res = await call(`/tasks/${encodeURIComponent(taskId)}/subtasks`, body);
    if (!res.ok) {
      // O motivo da recusa (limite, id repetido…) volta ao agente; só o campo `detail`, nunca o corpo bruto.
      const p = (await res.json().catch(() => null)) as { detail?: string; errors?: Array<{ message: string }> } | null;
      throw new Error(`${p?.detail ?? 'recusado'}${p?.errors?.length ? ` ${p.errors.map((e) => e.message).join(' ')}` : ''} (HTTP ${res.status})`.slice(0, 400));
    }
    return (await res.json()) as { added: string[] };
  },
  async requestApproval(taskId, req) {
    const res = await call(`/tasks/${encodeURIComponent(taskId)}/approvals`, req);
    if (!res.ok) throw new Error(`aprovação recusada pelo servidor: ${res.status}`);
    return (await res.json()) as { approvalId: string };
  },
  async approvalStatus(taskId, approvalId) {
    const res = await fetch(`${apiUrl}/api/v1/runner/tasks/${encodeURIComponent(taskId)}/approvals/${encodeURIComponent(approvalId)}`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`consulta de aprovação falhou: ${res.status}`);
    return (await res.json()) as { status: string; reason?: string };
  },
  async complete(taskId, body, attempt) {
    const res = await call(`/tasks/${encodeURIComponent(taskId)}/complete`, { ...body, attempt });
    if (!res.ok) throw new Error(`complete falhou: ${res.status}`);
  },
  async fail(taskId, reason, attempt) {
    await call(`/tasks/${encodeURIComponent(taskId)}/fail`, { reason, attempt });
  },
};

// Algum provedor configurado no ambiente deste Runner? (Ollama conta quando a URL foi definida: ele roda local e não tem chave.)
const anyProvider = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OLLAMA_BASE_URL);
// RUNNER_EXECUTOR: agent (modelo real, padrão se houver chave) | agent-demo (roteiro fixo, sem chave) | simulated (padrão sem chave).
// Claude Code instalado e logado (assinatura): o Runner o aciona como processo, sem chave de API.
let claudeVersion: string | null = null;
try {
  claudeVersion = execFileSync(process.env.RUNNER_CLAUDE_BIN || 'claude', ['--version'], { timeout: 8_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split(/\r?\n/)[0] ?? null;
} catch {
  /* não instalado */
}
// Codex instalado (assinatura ChatGPT): versão e se há login (o login só a pessoa faz: `codex login`).
let codexVersion: string | null = null;
let codexLogin = 'não verificado';
try {
  const c = resolveCodexCommand();
  const run = (extra: string[]) => execFileSync(c.file, [...(c.prefixArgs ?? []), ...extra], { timeout: 15_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  codexVersion = run(['--version']).split(/\r?\n/)[0] ?? null;
  try {
    codexLogin = run(['login', 'status']).split(/\r?\n/)[0] ?? 'sem login';
  } catch (e) {
    const out = String((e as { stdout?: Buffer; stderr?: Buffer }).stdout ?? '') + String((e as { stderr?: Buffer }).stderr ?? '');
    codexLogin = (out.trim().split(/\r?\n/)[0] || 'sem login').slice(0, 80);
  }
} catch {
  /* não instalado */
}
const mode = process.env.RUNNER_EXECUTOR ?? (anyProvider || claudeVersion || codexVersion ? 'agent' : 'simulated');
const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

let sandbox: Sandbox | undefined;
let sandboxNote = 'desativado (RUNNER_SANDBOX=off)';
if (process.env.RUNNER_SANDBOX !== 'off') {
  const image = process.env.RUNNER_SANDBOX_IMAGE ?? 'node:22-alpine';
  const probe = await probeDocker(image);
  if (probe.available) {
    sandbox = new DockerSandbox({ image, memory: process.env.RUNNER_SANDBOX_MEMORY, cpus: process.env.RUNNER_SANDBOX_CPUS, pidsLimit: process.env.RUNNER_SANDBOX_PIDS ? num('RUNNER_SANDBOX_PIDS', 128) : undefined });
    sandboxNote = `Docker, imagem ${image}`;
  } else {
    sandboxNote = `INDISPONÍVEL: ${probe.reason}. Comandos do agente ficam desativados (nunca rodam fora do sandbox).`;
  }
}

let executor = simulatedExecutor;
if (mode === 'agent' || mode === 'agent-demo') {
  if (mode === 'agent' && !anyProvider && !claudeVersion && !codexVersion) {
    console.error('RUNNER_EXECUTOR=agent exige a chave de ao menos um provedor (ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY), OLLAMA_BASE_URL o Claude Code ou o Codex instalados e logados.');
    process.exit(1);
  }
  executor = agentExecutor({
    createModel: (job) => (mode === 'agent-demo' ? demoModel(job.model, { subtasks: process.env.RUNNER_DEMO_SUBTASKS === '1', messages: process.env.RUNNER_DEMO_MESSAGES === '1', team: process.env.RUNNER_DEMO_TEAM === '1' }) : createModelFor(job)),
    dataDir: process.env.RUNNER_DATA_DIR ?? join(homedir(), '.command-ai-runner'),
    sandbox,
    allowDirectWrites: process.env.RUNNER_ALLOW_DIRECT_WRITES === '1',
    commandTimeoutMs: num('RUNNER_COMMAND_TIMEOUT_MS', 300_000),
    limits: {
      maxTurns: num('RUNNER_MAX_TURNS', 25),
      maxTotalTokens: num('RUNNER_MAX_TOTAL_TOKENS', 500_000),
      timeoutMs: num('RUNNER_TASK_TIMEOUT_MS', 30 * 60_000),
      maxTokensPerTurn: num('RUNNER_MAX_TOKENS_PER_TURN', 8192),
      maxToolOutputBytes: num('RUNNER_MAX_TOOL_OUTPUT_BYTES', 2_000_000),
      approvalPollMs: num('RUNNER_APPROVAL_POLL_MS', 2000),
      approvalTimeoutMs: num('RUNNER_APPROVAL_TIMEOUT_MS', 15 * 60_000),
    },
  });
}
// Cada agente escolhe o provedor: assinatura local (Claude Code), simulado, ou API. No modo de demonstração tudo usa o modelo de demonstração.
const baseExecutor = executor;
const claudeExec = claudeCodeExecutor({
  dataDir: process.env.RUNNER_DATA_DIR ?? join(homedir(), '.command-ai-runner'),
  timeoutMs: num('RUNNER_TASK_TIMEOUT_MS', 30 * 60_000),
  sandbox,
  commandTimeoutMs: num('RUNNER_COMMAND_TIMEOUT_MS', 300_000),
  approvalPollMs: num('RUNNER_APPROVAL_POLL_MS', 2000),
  approvalTimeoutMs: num('RUNNER_APPROVAL_TIMEOUT_MS', 15 * 60_000),
});
const codexExec = codexExecutor({
  dataDir: process.env.RUNNER_DATA_DIR ?? join(homedir(), '.command-ai-runner'),
  timeoutMs: num('RUNNER_TASK_TIMEOUT_MS', 30 * 60_000),
  sandbox,
  commandTimeoutMs: num('RUNNER_COMMAND_TIMEOUT_MS', 300_000),
  approvalPollMs: num('RUNNER_APPROVAL_POLL_MS', 2000),
  approvalTimeoutMs: num('RUNNER_APPROVAL_TIMEOUT_MS', 15 * 60_000),
});
executor = routeExecutor({ mode, base: baseExecutor, claude: claudeExec, codex: codexExec, simulated: simulatedExecutor });
console.log(`Runner conectado a ${apiUrl}`);
console.log(`Executor: ${mode === 'agent' ? 'agente (modelo escolhido pelo provedor de cada agente)' : mode === 'agent-demo' ? 'agente de demonstração (roteiro fixo, sem chave)' : 'simulado (defina a chave de um provedor, por exemplo ANTHROPIC_API_KEY, para o agente real)'}`);
if (mode !== 'simulated') console.log(`Sandbox de comandos: ${sandboxNote}`);
if (mode === 'agent') {
  for (const line of providerCheck()) console.log(`Provedor ${line}`);
  console.log(`Provedor codex: ${codexVersion ? `${codexVersion} (assinatura local; login: ${codexLogin})` : 'não encontrado (npm i -g @openai/codex e codex login)'}`);
  console.log(`Provedor claude_code: ${claudeVersion ? `Claude Code ${claudeVersion} (assinatura local, sem chave)` : 'não encontrado (instale e faça login, ou defina RUNNER_CLAUDE_BIN)'}`);
}
console.log(`Workspaces autorizados: ${allowedWorkspaces.join(', ')}`);

let running = true;
process.on('SIGINT', () => {
  running = false;
  console.log('Encerrando depois da tarefa atual…');
});
process.on('SIGTERM', () => {
  running = false;
});

while (running) {
  try {
    const outcome = await processNextJob({ client, executor, allowedWorkspaces, signingKey });
    if (outcome !== 'idle') console.log(`Tarefa: ${outcome}`);
    if (outcome === 'idle') await new Promise((r) => setTimeout(r, pollMs));
  } catch (err) {
    console.error('Erro de comunicação:', err instanceof Error ? err.message : err);
    await new Promise((r) => setTimeout(r, Math.min(pollMs * 5, 15_000)));
  }
}
