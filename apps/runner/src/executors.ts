import type { Executor } from './runner.ts';

/** Espera `ms`, mas acorda na hora se o servidor mandar cancelar. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('cancelado'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('cancelado'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Estima tokens (~4 caracteres por token). Só usado pelo executor simulado. */
const estimateTokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));

/**
 * Executor simulado: não usa rede nem chave. Serve para validar o fluxo ponta a ponta
 * (plano, aprovação, streaming, custo, cancelamento) sem gastar tokens.
 */
export const simulatedExecutor: Executor = async (job, emit, signal) => {
  const steps = [
    `Lendo o workspace ${job.workspacePath}`,
    'Analisando o objetivo da tarefa',
    'Aplicando as instruções do agente',
    'Consolidando o resultado',
  ];
  for (const step of steps) {
    emit(step);
    await sleep(Number(process.env.SIMULATED_STEP_MS ?? 600), signal);
  }
  const output = `Resultado simulado para: ${job.prompt.split('\n')[0]}`;
  return {
    output,
    usage: { model: job.model, inputTokens: estimateTokens(job.prompt + (job.instructions ?? '')), outputTokens: estimateTokens(output) * 8 },
  };
};
