import type { ModelClient, ModelTurn, ToolCall } from './types.ts';

/**
 * Modelo de demonstração: um roteiro fixo, sem rede e sem chave. Serve para validar de ponta a ponta o laço do agente,
 * o worktree, o sandbox, o relato de uso e a aprovação humana sem gastar tokens. NÃO é inteligência de verdade.
 */
export function demoModel(modelName = 'demo', opts: { subtasks?: boolean } = {}): ModelClient {
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

  // Com a opção ligada, só a tarefa de análise delega: cria duas subtarefas encadeadas. As filhas não criam outras.
  const delegating = [
    { text: 'Vou explorar o projeto.', tools: [call('d1', 'list_dir', { path: '.' })] },
    {
      text: 'Delegando parte do trabalho.',
      tools: [
        call('d2', 'plan_subtasks', {
          tasks: [
            { id: 'sub-docs', title: 'Subtarefa: criar o arquivo SUBTAREFA-1.md com um resumo do projeto', risk: 'low' },
            { id: 'sub-rev', title: 'Subtarefa: conferir o SUBTAREFA-1.md e criar o SUBTAREFA-2.md com a revisão', dependsOn: ['sub-docs'], risk: 'low' },
          ],
        }),
      ],
    },
    { text: 'Concluído: deleguei duas subtarefas e deixei o resto para elas.', tools: [] as ToolCall[] },
  ];
  // As subtarefas escrevem os próprios arquivos (sem rascunho), para o resultado ficar fácil de conferir.
  const child = (n: number) => [
    { text: 'Lendo o que a tarefa anterior deixou.', tools: [call('c1', 'list_dir', { path: '.' })] },
    { text: 'Escrevendo o arquivo.', tools: [call('c2', 'write_file', { path: `SUBTAREFA-${n}.md`, content: `# Subtarefa ${n}\nCriado por um agente de demonstração.\n` })] },
    { text: `Concluído: SUBTAREFA-${n}.md criado.`, tools: [] as ToolCall[] },
  ];

  return {
    model: modelName,
    async turn(req): Promise<ModelTurn> {
      const done = req.messages.filter((m) => m.role === 'assistant').length;
      const first = req.messages[0];
      const prompt = first && first.role === 'user' ? first.content : '';
      let script = steps;
      if (opts.subtasks) {
        if (/^Analisar/.test(prompt)) script = delegating;
        else if (/^Subtarefa: criar/.test(prompt)) script = child(1);
        else if (/^Subtarefa: conferir/.test(prompt)) script = child(2);
      }
      const step = script[Math.min(done, script.length - 1)]!;
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
