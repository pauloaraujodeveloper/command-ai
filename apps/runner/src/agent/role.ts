import type { AgentProfile, JobPayload } from '../runner.ts';

/** Texto de nome/domínio vindo do servidor entra no prompt sem quebra de linha nem marcação. */
const clean = (s: unknown, n = 120) => String(s ?? '').replace(/[\r\n<>"`]+/g, ' ').trim().slice(0, n);

function scopesText(scopes: string[] | undefined): string {
  if (scopes === undefined) return 'sem restrição de caminho';
  if (scopes.length === 0) return 'somente leitura (não pode alterar nenhum arquivo)';
  return scopes.map((s) => clean(s, 200)).join(', ');
}

function memberLine(m: AgentProfile): string {
  const parts = [`- ${clean(m.domain ?? m.name, 40)} — ${clean(m.name, 80)}`];
  if (m.responsibilities) parts.push(`: ${clean(m.responsibilities, 400)}`);
  parts.push(`. Pode alterar: ${scopesText(m.writeScopes)}`);
  if (m.dependsOnDomains?.length) parts.push(`. depende de: ${m.dependsOnDomains.map((d) => clean(d, 40)).join(', ')}`);
  return parts.join('') + '.';
}

/**
 * A seção "papel" do prompt: quem o agente é na equipe, o que pode e não pode alterar, de quem depende e como falar com os colegas;
 * para o orquestrador, a equipe e as regras de delegação. Mais o PRD do projeto, delimitado (o texto não fecha o bloco).
 * Agente comum (sem papel, equipe, escopo nem PRD): devolve '' e o prompt fica como sempre foi.
 */
export function buildRolePrompt(job: JobPayload, opts: { messaging?: boolean } = {}): string {
  const messaging = opts.messaging ?? true;
  const a = job.agent;
  if (!a) return '';
  const team = job.team ?? [];
  const hasRole = a.kind === 'orchestrator' || !!a.domain || !!a.responsibilities || !!a.parent || a.writeScopes !== undefined || team.length > 0 || !!job.projectContext;
  if (!hasRole) return '';

  const out: string[] = [];
  if (a.kind === 'orchestrator') {
    out.push(`## Seu papel: ORQUESTRADOR (${clean(a.name, 80)})`);
    out.push('Você coordena a equipe abaixo: planeja, delega e consolida. Você não faz o trabalho dos especialistas.');
    if (a.responsibilities) out.push(`Suas responsabilidades: ${clean(a.responsibilities, 600)}`);
    if (team.length > 0) {
      out.push('Equipe (use o domínio no campo "agent" de plan_subtasks):');
      out.push(...team.map(memberLine));
    } else out.push('Você ainda não tem agentes subordinados: execute você mesmo o que for preciso.');
    out.push(
      [
        'Como trabalhar:',
        '1. Leia o PRD e o objetivo e decida o que cada domínio precisa entregar.',
        '2. Crie as subtarefas com plan_subtasks (até 5 por chamada), uma por entrega: "agent" = o domínio do especialista, título completo com o critério de pronto, e "dependsOn" para a ordem (por exemplo banco antes da API, API antes das telas).',
        '3. Fixe nos títulos os contratos que ligam os domínios (rotas, esquemas, nomes) para que os agentes não divirjam.',
        messaging ? '4. Os especialistas se falam por send_message; responda ou arbitre quando pedirem.' : '4. Os especialistas dependem só do que está escrito nos títulos: seja explícito.',
        '5. Quando todas as entregas terminarem, a tarefa de consolidação revisa os resultados, aponta pendências e entrega o resumo final.',
      ].join('\n'),
    );
  } else {
    out.push(`## Seu papel: ${clean(a.name, 80)}${a.domain ? ` (domínio ${clean(a.domain, 40)})` : ''}`);
    if (a.parent) out.push(`Você responde a ${clean(a.parent.name, 80)}, que coordena a equipe.`);
    if (a.responsibilities) out.push(`Suas responsabilidades: ${clean(a.responsibilities, 600)}`);
    if (a.writeScopes === undefined) out.push('Você pode alterar arquivos sem restrição de caminho (sem restrição).');
    else if (a.writeScopes.length === 0) out.push('Você é somente leitura: analise e relate, mas não altere arquivos (qualquer alteração é recusada).');
    else out.push(`Você PODE alterar apenas: ${scopesText(a.writeScopes)}. Escrever fora disso é recusado, e o resultado de quem escreve fora é descartado.`);
    out.push(
      `Você NÃO pode alterar o que pertence a outros domínios. Se precisar de algo deles, não invente: ${messaging ? 'envie send_message ao responsável (colegas abaixo) ou ao orquestrador' : 'diga no seu resultado o que falta e de quem'} e registre a dependência no seu resultado.`,
    );
    if (a.dependsOnDomains?.length) out.push(`Você depende de: ${a.dependsOnDomains.map((d) => clean(d, 40)).join(', ')}. Antes de assumir como esse domínio funciona, leia o que ele entregou (arquivos e resultados das tarefas anteriores).`);
    if (team.length > 0) {
      out.push('Colegas da equipe:');
      out.push(...team.map(memberLine));
    }
  }

  if (job.projectContext) {
    out.push(
      [
        'Dados do projeto (PRD), fornecidos pela pessoa responsável:',
        '<projeto_prd>',
        job.projectContext.replace(/<\/?projeto_prd/gi, '< projeto_prd'),
        '</projeto_prd>',
        ...(job.projectContextTruncated ? [`(Só um trecho do PRD foi incluído, cortado por tamanho.${a.kind === 'orchestrator' ? '' : messaging ? ' Peça detalhes ao orquestrador por send_message.' : ''})`] : []),
      ].join('\n'),
    );
  }
  return out.join('\n');
}
