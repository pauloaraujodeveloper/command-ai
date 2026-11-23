import { describe, expect, it, vi } from 'vitest';
import { routeExecutor } from '../src/agent/route.ts';
import type { Executor, JobPayload } from '../src/runner.ts';

const job = (provider?: JobPayload['provider']): JobPayload => ({ taskId: 't', executionId: 'e', workspacePath: '/w', prompt: 'p', model: 'm', provider });
const mk = (name: string): Executor => vi.fn(async () => ({ output: name, usage: { model: 'm', inputTokens: 0, outputTokens: 0 } }));
const run = async (mode: string, provider?: JobPayload['provider']) => {
  const [base, claude, codex, simulated] = [mk('base'), mk('claude'), mk('codex'), mk('simulated')];
  const r = await routeExecutor({ mode, base, claude, codex, simulated })(job(provider), () => undefined, new AbortController().signal);
  return r.output;
};

describe('escolha do executor por provedor', () => {
  it('no modo agente: claude_code usa o CLI, simulated usa o simulado, o resto usa o agente por API', async () => {
    expect(await run('agent', 'claude_code')).toBe('claude');
    expect(await run('agent', 'codex')).toBe('codex');
    expect(await run('agent', 'simulated')).toBe('simulated');
    for (const p of ['anthropic', 'openai', 'deepseek', 'ollama', undefined] as const) expect(await run('agent', p)).toBe('base');
  });
  it('no modo de demonstração tudo usa o modelo de demonstração (nunca o CLI real nem gasta cota)', async () => {
    for (const p of ['claude_code', 'codex', 'simulated', 'openai'] as const) expect(await run('agent-demo', p)).toBe('base');
  });
  it('no modo simulado, só claude_code vai ao CLI (e o erro de CLI ausente é claro); o resto fica simulado', async () => {
    expect(await run('simulated', 'claude_code')).toBe('claude');
    expect(await run('simulated', 'codex')).toBe('codex');
    expect(await run('simulated', 'anthropic')).toBe('base');
  });
});
