import type { Executor } from '../runner.ts';

/**
 * Escolhe o executor de cada trabalho pelo provedor do agente:
 *  - claude_code: assinatura local (CLI), exceto no modo de demonstração (que usa o modelo de demonstração para tudo);
 *  - simulated: executor simulado quando o Runner está no modo agente (a tarefa de demonstração de sempre);
 *  - demais: o agente por API (ou o executor padrão do modo).
 */
export function routeExecutor(o: { mode: string; base: Executor; claude: Executor; simulated: Executor }): Executor {
  return (job, emit, signal, ctx) => {
    if (o.mode !== 'agent-demo' && job.provider === 'claude_code') return o.claude(job, emit, signal, ctx);
    if (o.mode === 'agent' && job.provider === 'simulated') return o.simulated(job, emit, signal, ctx);
    return o.base(job, emit, signal, ctx);
  };
}
