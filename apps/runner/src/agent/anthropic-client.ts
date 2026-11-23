import Anthropic from '@anthropic-ai/sdk';
import { toApiObject } from './schema.ts';
import type { AgentMessage, ModelClient, ModelRequest, ModelTurn, StopReason, ToolCall, ToolSpec } from './types.ts';

export interface AnthropicClientOptions {
  apiKey: string;
  model: string;
  /** Tentativas do SDK para erros temporários (rede, 429, 5xx, 529), com espera crescente. */
  maxRetries?: number;
  baseURL?: string;
  /** Troca o `fetch` (testes). */
  fetch?: typeof fetch;
}

export function toApiTool(spec: ToolSpec): Anthropic.Tool {
  return {
    name: spec.name,
    description: spec.description,
    strict: true,
    input_schema: toApiObject(spec.inputSchema) as Anthropic.Tool['input_schema'],
  };
}

function toApiMessages(messages: AgentMessage[]): Anthropic.MessageParam[] {
  return messages.map((m): Anthropic.MessageParam => {
    if (m.role === 'user') return { role: 'user', content: m.content };
    // Conteúdo do assistente volta exatamente como veio (blocos de raciocínio exigem isso).
    if (m.role === 'assistant') return { role: 'assistant', content: m.raw as Anthropic.ContentBlockParam[] };
    return {
      role: 'user',
      content: m.results.map((r): Anthropic.ToolResultBlockParam => ({
        type: 'tool_result',
        tool_use_id: r.toolCallId,
        content: r.content,
        ...(r.isError ? { is_error: true } : {}),
      })),
    };
  });
}

const STOP: Record<string, StopReason> = { end_turn: 'end_turn', tool_use: 'tool_use', max_tokens: 'max_tokens', refusal: 'refusal', pause_turn: 'pause_turn' };

/** Mensagens de erro em português, sem corpo bruto da resposta e sem a chave. */
export function explainError(err: unknown, apiKey: string): Error {
  const scrub = (s: string) => (apiKey ? s.split(apiKey).join('[REDACTED]') : s);
  if (err instanceof Anthropic.AuthenticationError) return new Error('Chave de API inválida ou revogada (provedor respondeu 401)');
  if (err instanceof Anthropic.PermissionDeniedError) return new Error('Sem permissão para este modelo ou recurso (provedor respondeu 403)');
  if (err instanceof Anthropic.NotFoundError) return new Error('Modelo não encontrado no provedor (404): confira o nome do modelo do agente');
  if (err instanceof Anthropic.RateLimitError) return new Error('Limite de taxa do provedor atingido (429); tente novamente mais tarde');
  if (err instanceof Anthropic.BadRequestError) return new Error(scrub(`Requisição recusada pelo provedor (400): ${err.message}`).slice(0, 400));
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new Error('Tempo esgotado ao falar com o provedor');
  if (err instanceof Anthropic.APIConnectionError) return new Error('Falha de rede ao falar com o provedor');
  if (err instanceof Anthropic.APIError) return new Error(scrub(`Provedor respondeu ${err.status ?? 'erro'}`));
  return new Error(scrub(err instanceof Error ? err.message : String(err)).slice(0, 400));
}

/** Cliente de modelo sobre o SDK oficial da Anthropic. A chave nunca sai da máquina do Runner. */
export class AnthropicModelClient implements ModelClient {
  readonly model: string;
  private readonly client: Anthropic;
  private readonly apiKey: string;

  constructor(opts: AnthropicClientOptions) {
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.client = new Anthropic({ apiKey: opts.apiKey, maxRetries: opts.maxRetries ?? 4, baseURL: opts.baseURL, fetch: opts.fetch });
  }

  async turn(req: ModelRequest): Promise<ModelTurn> {
    let parseFailures = 0;
    for (;;) {
      if (req.signal.aborted) throw new Error('cancelado');
      try {
        const stream = this.client.messages.stream(
          {
            model: this.model,
            max_tokens: req.maxTokens,
            system: req.system,
            messages: toApiMessages(req.messages),
            tools: req.tools.map(toApiTool),
            tool_choice: { type: 'auto' },
            // Cache automático do prefixo (sistema, ferramentas e histórico): cada turno relê quase tudo do anterior.
            cache_control: { type: 'ephemeral' },
          },
          { signal: req.signal },
        );
        const message = await stream.finalMessage();
        return this.toTurn(message);
      } catch (err) {
        if (req.signal.aborted) throw new Error('cancelado');
        // Entrada de ferramenta ilegível ou conexão cortada no meio: não é erro da API, repete o turno (poucas vezes).
        if (!(err instanceof Anthropic.APIError) && parseFailures++ < 2) continue;
        throw explainError(err, this.apiKey);
      }
    }
  }

  private toTurn(message: Anthropic.Message): ModelTurn {
    const toolCalls: ToolCall[] = [];
    let text = '';
    for (const b of message.content) {
      if (b.type === 'text') text += b.text;
      else if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, input: b.input });
    }
    const u = message.usage;
    const usage: ModelTurn['usage'] = { model: this.model, inputTokens: u.input_tokens, outputTokens: u.output_tokens };
    if (u.cache_read_input_tokens) usage.cacheReadTokens = u.cache_read_input_tokens;
    if (u.cache_creation_input_tokens) usage.cacheWriteTokens = u.cache_creation_input_tokens;
    const reason = message.stop_reason ?? 'end_turn';
    const details = (message as { stop_details?: { category?: string | null } | null }).stop_details;
    return {
      text,
      toolCalls,
      stopReason: STOP[reason] ?? 'other',
      refusalCategory: details?.category ?? null,
      usage,
      raw: message.content,
    };
  }
}
