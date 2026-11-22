import type { Executor, JobPayload } from '../runner.ts';
import { buildSystemPrompt, runAgent, type AgentLimits } from './loop.ts';
import type { Sandbox } from './sandbox.ts';
import type { ModelClient } from './types.ts';
import { createTaskWorkspace } from './worktree.ts';

export interface AgentExecutorOptions {
  createModel: (job: JobPayload) => ModelClient;
  /** Pasta de dados do Runner: worktrees e patches ficam aqui, fora dos repositórios. */
  dataDir: string;
  limits: AgentLimits;
  sandbox?: Sandbox;
  /** Permite escrever direto em pastas sem Git (cada escrita passa por aprovação). Padrão: somente leitura. */
  allowDirectWrites?: boolean;
  commandTimeoutMs?: number;
}

const MAX_PATCH_IN_OUTPUT = 20_000;

/**
 * Executor do agente: prepara um workspace isolado, roda o laço (modelo + ferramentas + aprovações),
 * e entrega o resultado como um patch para revisão. Nada é aplicado à pasta da pessoa automaticamente.
 */
export function agentExecutor(o: AgentExecutorOptions): Executor {
  return async (job, emit, signal, ctx) => {
    if (!ctx) throw new Error('O executor do agente precisa do contexto do Runner (cliente) para relatar uso e pedir aprovação');

    const ws = await createTaskWorkspace({
      workspacePath: job.workspacePath,
      taskId: job.taskId,
      attempt: job.attempt ?? 1,
      dataDir: o.dataDir,
      allowDirectWrites: o.allowDirectWrites,
    });
    emit(
      ws.kind === 'worktree'
        ? 'Workspace: worktree Git isolado (a sua pasta não é alterada)'
        : ws.kind === 'direct'
          ? 'Workspace: escrita direta autorizada (cada escrita exige aprovação)'
          : 'Workspace: somente leitura (a pasta não é um repositório Git com commit)',
    );
    emit(o.sandbox ? 'Comandos: sandbox Docker (sem rede, sem privilégios, com limites)' : 'Comandos: desativados (sandbox indisponível)');

    try {
      const model = o.createModel(job);
      const result = await runAgent({
        model,
        workspace: { root: ws.root, kind: ws.kind },
        sandbox: o.sandbox,
        client: ctx.client,
        taskId: job.taskId,
        attempt: job.attempt,
        system: buildSystemPrompt(job.instructions),
        prompt: job.prompt,
        emit,
        signal,
        limits: o.limits,
        commandTimeoutMs: o.commandTimeoutMs,
      });

      const fin = await ws.finalize();
      let output = result.output.trim();
      if (ws.kind === 'worktree') {
        if (fin.changedFiles > 0) {
          output += `\n\n---\nAlterações em worktree isolado (nada foi aplicado à sua pasta): ${fin.changedFiles} arquivo${fin.changedFiles === 1 ? '' : 's'}\n${fin.stat}\nPatch completo: ${fin.patchFile}\nPara aplicar: git apply "${fin.patchFile}"`;
          if (fin.patch) output += `\n\n\`\`\`diff\n${fin.patch.slice(0, MAX_PATCH_IN_OUTPUT)}${fin.patch.length > MAX_PATCH_IN_OUTPUT ? '\n[patch cortado: veja o arquivo]' : ''}\n\`\`\``;
        } else {
          output += '\n\n---\nO agente não alterou arquivos.';
        }
      } else if (ws.kind === 'readonly') {
        output += '\n\n---\nPasta em modo somente leitura (não é um repositório Git com commit): o agente não pôde alterar arquivos.';
      }

      emit(`Concluído em ${result.turns} interação(ões) com o modelo`);
      return {
        output,
        // O servidor já recebeu o uso de cada turno; aqui vai só o que falhou ao relatar.
        usage: result.unreportedUsage ?? { model: model.model, inputTokens: 0, outputTokens: 0 },
      };
    } finally {
      await ws.cleanup().catch(() => undefined);
    }
  };
}
