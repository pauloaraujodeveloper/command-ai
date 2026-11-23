import { toApiObject } from './schema.ts';
import type { AgentMessage, ModelClient, ModelRequest, ModelTurn, StopReason, ToolCall, ToolSpec } from './types.ts';

export type OpenAiCompatKind = 'openai' | 'deepseek' | 'ollama';

export interface OpenAiCompatOptions {
  kind: OpenAiCompatKind;
  model: string;
  /** Base da API, por exemplo https://api.openai.com/v1 ou http://127.0.0.1:11434/v1. */
  baseURL: string;
  /** Ausente em servidores locais (Ollama). Nunca sai do ambiente do Runner. */
  apiKey?: string;
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

function toApiTool(spec: ToolSpec) {
  // Sem `strict`: nem todo servidor compatível o aceita. O Runner valida cada entrada localmente antes de executar.
  return { type: 'function' as const, function: { name: spec.name, description: spec.description, parameters: toApiObject(spec.inputSchema) } };
}

function toApiMessages(system: string, messages: AgentMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    // A mensagem do assistente volta exatamente como veio (inclusive tool_calls e ids).
    else if (m.role === 'assistant') out.push(m.raw as Record<string, unknown>);
    // A API não tem is_error: o erro vai no texto, para o modelo saber que a ferramenta falhou.
    else for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.isError ? `ERRO: ${r.content}` : r.content });
  }
  return out;
}

const FINISH: Record<string, StopReason> = { stop: 'end_turn', tool_calls: 'tool_use', function_call: 'tool_use', length: 'max_tokens', content_filter: 'refusal' };

interface RawChoice {
  message?: { role?: string; content?: string | null; tool_calls?: Array<{ id: string; type?: string; function: { name: string; arguments: string } }> };
  finish_reason?: string | null;
}
interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  prompt_cache_hit_tokens?: number;
}

/**
 * Cliente de modelo para qualquer servidor que fale o protocolo Chat Completions (OpenAI, DeepSeek, Ollama e outros).
 * Usa `fetch` direto: a API é pequena e estável, e assim não há mais uma dependência com acesso à chave.
 */
export class OpenAiCompatModelClient implements ModelClient {
  readonly model: string;
  private readonly o: Required<Pick<OpenAiCompatOptions, 'maxRetries' | 'retryDelayMs' | 'timeoutMs'>> & OpenAiCompatOptions;

  constructor(opts: OpenAiCompatOptions) {
    this.model = opts.model;
    this.o = { maxRetries: 3, retryDelayMs: 800, timeoutMs: 120_000, ...opts };
  }

  private scrub(s: string): string {
    return this.o.apiKey ? s.split(this.o.apiKey).join('[REDACTED]') : s;
  }

  async turn(req: ModelRequest): Promise<ModelTurn> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toApiMessages(req.system, req.messages),
      // A OpenAI moderna pede max_completion_tokens; DeepSeek e Ollama ainda usam max_tokens.
      [this.o.kind === 'openai' ? 'max_completion_tokens' : 'max_tokens']: req.maxTokens,
    };
    if (req.tools.length > 0) {
      body.tools = req.tools.map(toApiTool);
      body.tool_choice = 'auto';
    }
    const url = `${this.o.baseURL.replace(/\/+$/, '')}/chat/completions`;
    const doFetch = this.o.fetch ?? fetch;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.o.apiKey) headers.authorization = `Bearer ${this.o.apiKey}`;

    for (let attempt = 0; ; attempt++) {
      if (req.signal.aborted) throw new Error('cancelado');
      let res: Response | undefined;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.any([req.signal, AbortSignal.timeout(this.o.timeoutMs)]),
        });
      } catch (err) {
        if (req.signal.aborted) throw new Error('cancelado');
        void err; // rede ou tempo esgotado: o texto do erro pode citar a chave, então só uma frase genérica sai daqui
        if (attempt >= this.o.maxRetries) throw new Error('Falha de rede ao falar com o provedor');
        await this.wait(this.backoff(attempt, null), req.signal);
        continue;
      }
      if (res.ok) return this.toTurn((await res.json().catch(() => null)) as { choices?: RawChoice[]; usage?: RawUsage } | null);

      const retriable = res.status === 429 || res.status >= 500;
      if (retriable && attempt < this.o.maxRetries) {
        await this.wait(this.backoff(attempt, res.headers.get('retry-after')), req.signal);
        continue;
      }
      throw await this.httpError(res);
    }
  }

  private backoff(attempt: number, retryAfter: string | null): number {
    const asked = retryAfter !== null ? Number(retryAfter) * 1000 : NaN;
    const exp = this.o.retryDelayMs * 2 ** attempt;
    return Number.isFinite(asked) ? Math.min(Math.max(asked, 0), 30_000) : Math.min(exp, 30_000);
  }

  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error('cancelado'));
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(new Error('cancelado'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Mensagens em português, sem corpo bruto da resposta e sem a chave. */
  private async httpError(res: Response): Promise<Error> {
    const s = res.status;
    if (s === 401) return new Error('Chave de API inválida ou revogada (provedor respondeu 401)');
    if (s === 403) return new Error('Sem permissão para este modelo ou recurso (provedor respondeu 403)');
    if (s === 404) return new Error('Modelo ou endereço não encontrado no provedor (404): confira o nome do modelo e a URL base');
    if (s === 429) return new Error('Limite de taxa do provedor atingido (429); tente novamente mais tarde');
    if (s === 400 || s === 422) {
      const p = (await res.json().catch(() => null)) as { error?: { message?: string } | string } | null;
      const msg = typeof p?.error === 'string' ? p.error : (p?.error?.message ?? '');
      return new Error(this.scrub(`Requisição recusada pelo provedor (${s}): ${msg}`).slice(0, 400));
    }
    return new Error(`Provedor respondeu ${s}`);
  }

  private toTurn(data: { choices?: RawChoice[]; usage?: RawUsage } | null): ModelTurn {
    const choice = data?.choices?.[0];
    const msg = choice?.message;
    if (!msg) throw new Error('Resposta inesperada do provedor: sem resposta do modelo');

    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c) => {
      let input: unknown;
      try {
        input = JSON.parse(c.function.arguments || '{}');
      } catch {
        input = c.function.arguments; // texto: o Runner recusa como entrada inválida e o modelo corrige
      }
      return { id: c.id, name: c.function.name, input };
    });

    const u = data?.usage ?? {};
    const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
    const usage: ModelTurn['usage'] = {
      model: this.model,
      inputTokens: Math.max(0, (u.prompt_tokens ?? 0) - cached),
      outputTokens: u.completion_tokens ?? 0,
    };
    if (cached) usage.cacheReadTokens = cached;

    const reason = choice?.finish_reason ?? 'stop';
    let stopReason: StopReason = FINISH[reason] ?? 'other';
    // Alguns servidores compatíveis respondem "stop" mesmo pedindo ferramentas.
    if (stopReason === 'end_turn' && toolCalls.length > 0) stopReason = 'tool_use';

    // Só o que a API aceita de volta: sem campos de raciocínio internos (reasoning_content etc.).
    const raw: Record<string, unknown> = { role: 'assistant', content: msg.content ?? null };
    if (msg.tool_calls?.length) raw.tool_calls = msg.tool_calls;

    return {
      text: msg.content ?? '',
      toolCalls,
      stopReason,
      refusalCategory: reason === 'content_filter' ? 'content_filter' : null,
      usage,
      raw,
    };
  }
}
