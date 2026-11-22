import type { ModelClient, ModelTurn, ToolCall } from './types.ts';

/**
 * Modelo de demonstração: um roteiro fixo, sem rede e sem chave. Serve para validar de ponta a ponta o laço do agente,
 * o worktree, o sandbox, o relato de uso e a aprovação humana sem gastar tokens. NÃO é inteligência de verdade.
 */
export function demoModel(modelName = 'demo'): ModelClient {
  const call = (id: string, name: string, input: Record<string, unknown>): ToolCall => ({ id, name, input });

  const report = [
    '# Relatório do agente (demonstração)',
    '',
    'Este arquivo foi criado por um agente de demonstração rodando em um worktree isolado.',
    'Nada foi aplicado à sua pasta: revise o patch e aplique se quiser.',
    '',
  ].join('\n');

  const steps: Array<{ text: string; tools: ToolCall[] }> = [
    { text: 'Vou explorar o projeto.', tools: [call('d1', 'list_dir', { path: '.' })] },
    { text: 'Conferindo o ambiente isolado.', tools: [call('d2', 'run_command', { command: 'ls -la /workspace | head -20' })] },
    { text: 'Criando um rascunho.', tools: [call('d3', 'write_file', { path: 'RASCUNHO.tmp', content: 'rascunho\n' })] },
    { text: 'Escrevendo o relatório.', tools: [call('d4', 'write_file', { path: 'AGENTE-RELATORIO.md', content: report })] },
    { text: 'Removendo o rascunho.', tools: [call('d5', 'delete_file', { path: 'RASCUNHO.tmp' })] },
    { text: 'Concluído: o relatório está em AGENTE-RELATORIO.md.', tools: [] },
  ];

  return {
    model: modelName,
    async turn(req): Promise<ModelTurn> {
      const done = req.messages.filter((m) => m.role === 'assistant').length;
      const step = steps[Math.min(done, steps.length - 1)]!;
      return {
        text: step.text,
        toolCalls: step.tools,
        stopReason: step.tools.length ? 'tool_use' : 'end_turn',
        usage: { model: modelName, inputTokens: 1200 + done * 300, outputTokens: 150 },
        raw: [{ type: 'text', text: step.text }, ...step.tools.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input }))],
      };
    },
  };
}
