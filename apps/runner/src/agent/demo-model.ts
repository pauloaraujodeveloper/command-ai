import type { ModelClient, ModelTurn, ToolCall } from './types.ts';

/**
 * Modelo de demonstração: um roteiro fixo, sem rede e sem chave. Serve para validar de ponta a ponta o laço do agente,
 * o worktree, o sandbox, o relato de uso e a aprovação humana sem gastar tokens. NÃO é inteligência de verdade.
 */
export function demoModel(modelName = 'demo', opts: { subtasks?: boolean; messages?: boolean; team?: boolean } = {}): ModelClient {
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

  // Equipe: o orquestrador delega a cada especialista (pelo domínio); cada um escreve no próprio escopo.
  // O front-end tenta escrever na API (recusado pelo escopo) e então registra o pedido; a API avisa o front-end do contrato.
  const teamScript = (prompt: string): Array<{ text: string; tools: ToolCall[] }> => {
    const marks = [/Equipe-DB:/, /Equipe-API:/, /Equipe-WEB:/, /Equipe-INFRA:/, /Analisar/, /Executar/, /Revisar/];
    let mine = -1;
    let at = Infinity;
    marks.forEach((re, i) => {
      const k = prompt.search(re);
      if (k >= 0 && k < at) {
        at = k;
        mine = i;
      }
    });
    const write = (id: string, path: string, content: string): ToolCall => call(id, 'write_file', { path, content });
    switch (mine) {
      case 0:
        return [
          { text: 'Modelando o banco.', tools: [write('b1', 'db/migrations/001_pedidos.sql', 'CREATE TABLE pedidos (id uuid PRIMARY KEY);\n')] },
          { text: 'Concluído: migração criada.', tools: [] as ToolCall[] },
        ];
      case 1:
        return [
          { text: 'Implementando a API.', tools: [write('a1', 'apps/api/pedidos.ts', 'export const rota = "/pedidos";\n')] },
          { text: 'Avisando o front-end do contrato.', tools: [call('a2', 'send_message', { to: 'web', content: 'Contrato: GET /pedidos devolve { items: [] }.' })] },
          { text: 'Concluído: API criada e contrato enviado.', tools: [] as ToolCall[] },
        ];
      case 2: {
        const got = /<mensagem_de_agente [^>]*>\n([\s\S]*?)\n<\/mensagem_de_agente>/.exec(prompt)?.[1] ?? '(nenhuma mensagem)';
        return [
          { text: 'Tentando alterar a API (não é minha área).', tools: [write('w1', 'apps/api/pedidos.ts', 'alterado pelo front\n')] },
          { text: 'Escrevendo a tela com o contrato recebido.', tools: [write('w2', 'apps/web/pedidos.tsx', `// ${got.replace(/\n/g, ' ')}\n`)] },
          { text: 'Concluído: tela criada; a API fica com o back-end.', tools: [] as ToolCall[] },
        ];
      }
      case 3:
        return [
          { text: 'Preparando o contêiner.', tools: [write('i1', 'Dockerfile', 'FROM node:24-alpine\n')] },
          { text: 'Concluído: Dockerfile criado.', tools: [] as ToolCall[] },
        ];
      case 4:
        return [
          { text: 'Vou explorar o projeto.', tools: [call('t1', 'list_dir', { path: '.' })] },
          {
            text: 'Delegando à equipe.',
            tools: [
              call('t2', 'plan_subtasks', {
                tasks: [
                  { id: 'db', title: 'Equipe-DB: criar a migração de pedidos', agent: 'database', risk: 'low' },
                  { id: 'api', title: 'Equipe-API: criar a rota de pedidos', agent: 'backend', dependsOn: ['db'], risk: 'low' },
                  { id: 'web', title: 'Equipe-WEB: criar a tela de pedidos', agent: 'frontend', dependsOn: ['api'], risk: 'low' },
                  { id: 'infra', title: 'Equipe-INFRA: criar o Dockerfile', agent: 'infra', risk: 'low' },
                ],
              }),
            ],
          },
          { text: 'Concluído: deleguei às quatro áreas.', tools: [] as ToolCall[] },
        ];
      default:
        return [
          { text: 'Conferindo o que a equipe deixou.', tools: [call('t3', 'list_dir', { path: '.' })] },
          { text: 'Concluído: conferi o resultado da equipe.', tools: [] as ToolCall[] },
        ];
    }
  };

  return {
    model: modelName,
    async turn(req): Promise<ModelTurn> {
      const done = req.messages.filter((m) => m.role === 'assistant').length;
      const first = req.messages[0];
      const prompt = first && first.role === 'user' ? first.content : '';
      let script = steps;
      if (opts.messages) {
        if (/^Analisar/.test(prompt)) {
          script = [
            { text: 'Vou explorar o projeto.', tools: [call('m1', 'list_dir', { path: '.' })] },
            { text: 'Avisando a revisão.', tools: [call('m2', 'send_message', { to: 'revisao', content: 'Aviso da análise: confira com atenção o arquivo README.md.' })] },
            { text: 'Concluído: deixei um aviso para a revisão.', tools: [] as ToolCall[] },
          ];
        } else if (/^Revisar/.test(prompt)) {
          // A mensagem chega no prompt (caixa de entrada entregue com o trabalho); o agente a copia para um arquivo.
          const got = /<mensagem_de_agente [^>]*>\n([\s\S]*?)\n<\/mensagem_de_agente>/.exec(prompt)?.[1] ?? '(nenhuma mensagem)';
          script = [
            { text: 'Lendo mensagens novas.', tools: [call('r1', 'read_messages', {})] },
            { text: 'Registrando o que recebi.', tools: [call('r2', 'write_file', { path: 'MENSAGEM-RECEBIDA.md', content: `# Mensagem recebida\n\n${got}\n` })] },
            { text: 'Concluído: registrei a mensagem recebida.', tools: [] as ToolCall[] },
          ];
        }
      }
      if (opts.team) script = teamScript(prompt);
      else if (opts.subtasks) {
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
