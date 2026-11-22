import type { Executor, ExecutorResult, JobPayload } from './runner.ts';

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

/**
 * Executor Anthropic (Messages API). A chave vem do ambiente da máquina do Runner e nunca passa pelo backend.
 * Nesta etapa a tarefa é uma única chamada sem ferramentas; o Claude Agent SDK entra na Fase 3.
 */
export function anthropicExecutor(apiKey: string, fetchImpl: typeof fetch = fetch): Executor {
  return async (job: JobPayload, emit, signal): Promise<ExecutorResult> => {
    emit(`Consultando ${job.model}`);
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: job.model,
        max_tokens: 2048,
        system: job.instructions,
        messages: [{ role: 'user', content: job.prompt }],
      }),
      signal: AbortSignal.any([AbortSignal.timeout(120_000), signal]),
    });
    if (!res.ok) {
      // Não devolve o corpo bruto: pode conter detalhes que não devem ir para os logs.
      throw new Error(`Provedor respondeu ${res.status}`);
    }
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const output = (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
    emit('Resposta recebida');
    return {
      output,
      usage: { model: job.model, inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 },
    };
  };
}
