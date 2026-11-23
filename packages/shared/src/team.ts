/*
 * Time de software padrão: um orquestrador e quatro especialistas (front-end, back-end, banco de dados, infraestrutura),
 * com responsabilidades, escopos de escrita e dependências iniciais. Os caminhos são um ponto de partida: o usuário ajusta ao projeto.
 */

export interface TeamAgentDef {
  name: string;
  role: string;
  instructions: string;
  providerKind: 'anthropic' | 'openai' | 'deepseek' | 'ollama' | 'claude_code' | 'codex' | 'simulated';
  model: string;
  budgetUsd: number;
  kind: 'orchestrator' | 'specialist';
  domain?: string;
  responsibilities?: string;
  writeScopes?: string[];
  dependsOnDomains: string[];
}

export function softwareTeam(o: { providerKind: TeamAgentDef['providerKind']; model: string; budgetUsd: number }): { orchestrator: TeamAgentDef; specialists: TeamAgentDef[] } {
  const common = { providerKind: o.providerKind, model: o.model, budgetUsd: o.budgetUsd };
  const orchestrator: TeamAgentDef = {
    ...common,
    name: 'Orquestrador',
    role: 'Planeja, delega e consolida o trabalho da equipe',
    instructions:
      'Você coordena a equipe. Leia o PRD do projeto, divida o pedido em tarefas por área e delegue cada uma ao especialista certo (campo agent: frontend, backend, database ou infra), declarando as dependências entre elas. ' +
      'Não altere arquivos você mesmo. Quando os especialistas terminarem, confira se as partes se encaixam e consolide o resultado final.',
    kind: 'orchestrator',
    responsibilities: 'Entende o pedido e o PRD, quebra em tarefas, escolhe quem faz cada uma, ordena pelas dependências e consolida o resultado. Não escreve código.',
    writeScopes: [],
    dependsOnDomains: [],
  };
  const spec = (s: Omit<TeamAgentDef, 'providerKind' | 'model' | 'budgetUsd' | 'kind'>): TeamAgentDef => ({ ...common, kind: 'specialist', ...s });
  const specialists: TeamAgentDef[] = [
    spec({
      name: 'Agente de Front-end',
      role: 'Interface e experiência do usuário',
      instructions: 'Você cuida da interface. Implemente telas, componentes e chamadas à API conforme o contrato combinado com o back-end. Se faltar um endpoint ou campo, peça ao agente de back-end em vez de inventar.',
      domain: 'frontend',
      responsibilities: 'Telas, componentes, estilos, estado do cliente e consumo da API. Não altera a API, o banco de dados nem a infraestrutura; se precisar de algo deles, envia uma mensagem ao agente responsável.',
      writeScopes: ['apps/web/**', 'web/**', 'frontend/**', 'client/**', 'src/components/**'],
      dependsOnDomains: ['backend'],
    }),
    spec({
      name: 'Agente de Back-end',
      role: 'API e regras de negócio',
      instructions: 'Você cuida da API e das regras de negócio. Implemente endpoints, validações e autorização. Use o esquema do banco definido pelo agente de banco de dados e avise o front-end quando o contrato mudar.',
      domain: 'backend',
      responsibilities: 'Endpoints, regras de negócio, autenticação e autorização, validação de entrada. Não altera telas, migrações de banco nem arquivos de infraestrutura; pede ao agente responsável.',
      writeScopes: ['apps/api/**', 'api/**', 'backend/**', 'server/**', 'src/server/**'],
      dependsOnDomains: ['database'],
    }),
    spec({
      name: 'Agente de Banco de Dados',
      role: 'Modelagem, migrações e consultas',
      instructions: 'Você cuida do banco de dados. Modele tabelas e índices, escreva migrações reversíveis e preserve os dados existentes. Documente o esquema para o back-end.',
      domain: 'database',
      responsibilities: 'Esquema, migrações, índices, consultas e integridade dos dados. Não altera código de aplicação nem infraestrutura; migrações destrutivas exigem aprovação.',
      writeScopes: ['**/migrations/**', '**/*.sql', 'prisma/**', 'db/**', 'drizzle/**'],
      dependsOnDomains: [],
    }),
    spec({
      name: 'Agente de Infraestrutura',
      role: 'Deploy, contêineres e pipelines',
      instructions: 'Você cuida da infraestrutura. Mantenha Dockerfiles, pipelines de CI/CD e configuração de ambientes. Nunca coloque segredos no repositório.',
      domain: 'infra',
      responsibilities: 'Dockerfile, docker-compose, CI/CD, configuração de deploy e variáveis de ambiente. Não altera código de aplicação nem migrações de banco.',
      writeScopes: ['Dockerfile*', 'docker-compose*.yml', '.github/**', 'infra/**', 'terraform/**', 'deploy/**'],
      dependsOnDomains: [],
    }),
  ];
  return { orchestrator, specialists };
}
