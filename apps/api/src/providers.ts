/** Capacidades como dados: a interface esconde ou desativa o que o provedor não oferece. */
export interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  structuredOutput: boolean;
  sessions: boolean;
  codeExecution: boolean;
  mcp: boolean;
  subagents: boolean;
  cancellation: boolean;
  usageMetrics: boolean;
}

export const CAPABILITIES: Record<'anthropic' | 'openai' | 'deepseek' | 'ollama' | 'claude_code' | 'codex' | 'simulated', ProviderCapabilities> = {
  anthropic: {
    streaming: true,
    toolCalling: true,
    structuredOutput: true,
    sessions: true,
    codeExecution: true,
    mcp: true,
    subagents: true,
    cancellation: true,
    usageMetrics: true,
  },
  openai: {
    streaming: true,
    toolCalling: true,
    structuredOutput: true,
    sessions: true,
    codeExecution: false,
    mcp: true,
    subagents: false,
    cancellation: true,
    usageMetrics: true,
  },
  deepseek: {
    streaming: true,
    toolCalling: true,
    structuredOutput: true,
    sessions: false,
    codeExecution: false,
    mcp: false,
    subagents: false,
    cancellation: true,
    usageMetrics: true,
  },
  // Claude Code pela assinatura do plano mensal (CLI local, sem chave): só ferramentas de arquivo, sem comandos, sem subtarefas, sem mensagens.
  claude_code: {
    streaming: true,
    toolCalling: true,
    structuredOutput: false,
    sessions: false,
    codeExecution: false,
    mcp: false,
    subagents: false,
    cancellation: true,
    usageMetrics: true,
  },
  // Codex pela assinatura ChatGPT (CLI local, sem chave): arquivos pelo sandbox do próprio Codex (sem o shell dele); comandos, apagar, subtarefas e mensagens pelas ferramentas do Runner (MCP).
  codex: {
    streaming: true,
    toolCalling: true,
    structuredOutput: false,
    sessions: false,
    codeExecution: false,
    mcp: false,
    subagents: false,
    cancellation: true,
    usageMetrics: true,
  },
  // Ollama chama ferramentas se o MODELO escolhido suportar (nem todos suportam); o Runner usa o mesmo laço do agente.
  ollama: {
    streaming: true,
    toolCalling: true,
    structuredOutput: false,
    sessions: false,
    codeExecution: false,
    mcp: false,
    subagents: false,
    cancellation: true,
    usageMetrics: false,
  },
  simulated: {
    streaming: true,
    toolCalling: false,
    structuredOutput: false,
    sessions: false,
    codeExecution: false,
    mcp: false,
    subagents: false,
    cancellation: true,
    usageMetrics: true,
  },
};

export const AGENT_TEMPLATES = [
  {
    id: 'code-auditor',
    name: 'Auditor de código',
    role: 'Auditoria de qualidade e segurança',
    instructions:
      'Leia o repositório sem alterar arquivos. Liste problemas de qualidade, segurança e desempenho com arquivo, linha, gravidade e correção sugerida.',
    model: 'claude-sonnet-5-5',
  },
  {
    id: 'refactorer',
    name: 'Refatorador',
    role: 'Refatoração incremental com testes',
    instructions:
      'Refatore em passos pequenos. Rode os testes a cada passo e pare se algum teste quebrar. Nunca altere comportamento sem um teste que o descreva.',
    model: 'claude-sonnet-5-5',
  },
  {
    id: 'test-writer',
    name: 'Escritor de testes',
    role: 'Cobertura de testes para fluxos críticos',
    instructions:
      'Escreva testes para os fluxos críticos primeiro. Cada teste cobre um comportamento e tem nome que o descreve. Não use mocks quando houver alternativa real.',
    model: 'claude-haiku-5-5',
  },
  {
    id: 'security-reviewer',
    name: 'Revisor de segurança',
    role: 'Revisão de vulnerabilidades (OWASP)',
    instructions:
      'Procure falhas de autorização, injeção, exposição de segredos e isolamento entre organizações. Classifique por gravidade e proponha correções verificáveis.',
    model: 'claude-opus-5-5',
  },
] as const;
