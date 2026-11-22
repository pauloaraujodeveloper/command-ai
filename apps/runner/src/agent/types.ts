/** Tipos comuns do agente: independentes do provedor de modelo. */

export interface JsonSchemaProp {
  type: 'string' | 'integer' | 'boolean';
  description?: string;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, JsonSchemaProp>;
    required: string[];
    additionalProperties: false;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  /** Exatamente como o modelo mandou: nunca confiar, sempre validar antes de usar. */
  input: unknown;
}

export interface TurnUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause_turn' | 'other';

export interface ModelTurn {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  /** Categoria informada pelo provedor numa recusa, quando houver. */
  refusalCategory?: string | null;
  usage: TurnUsage;
  /**
   * Conteúdo bruto do assistente, para reenviar na próxima chamada SEM reconstruir.
   * Em modelos com raciocínio, os blocos de pensamento precisam voltar intactos.
   */
  raw: unknown;
}

export interface ToolResultMessage {
  toolCallId: string;
  content: string;
  isError: boolean;
}

export type AgentMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; raw: unknown }
  | { role: 'tool_results'; results: ToolResultMessage[] };

export interface ModelRequest {
  system: string;
  messages: AgentMessage[];
  tools: ToolSpec[];
  maxTokens: number;
  signal: AbortSignal;
}

export interface ModelClient {
  readonly model: string;
  turn(req: ModelRequest): Promise<ModelTurn>;
}
