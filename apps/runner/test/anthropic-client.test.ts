import { describe, expect, it } from 'vitest';
import { AnthropicModelClient } from '../src/agent/anthropic-client.ts';
import { toolSpecs } from '../src/agent/tools.ts';
import type { ModelRequest } from '../src/agent/types.ts';

type Ev = { type: string } & Record<string, unknown>;

/** Resposta SSE no formato da Messages API (streaming). */
function sse(events: Ev[], status = 200): Response {
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

const start = (usage: Record<string, number> = { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 }): Ev => ({
  type: 'message_start',
  message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage },
});
const text = (i: number, t: string): Ev[] => [
  { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: t } },
  { type: 'content_block_stop', index: i },
];
const toolUse = (i: number, id: string, name: string, json: string): Ev[] => [
  { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id, name, input: {} } },
  { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: json } },
  { type: 'content_block_stop', index: i },
];
const end = (stop: string, extra: Record<string, unknown> = {}, outTokens = 42): Ev[] => [
  { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null, ...extra }, usage: { output_tokens: outTokens } },
  { type: 'message_stop' },
];

function make(responder: (req: { url: string; headers: Headers; body: Record<string, unknown> }) => Response | Promise<Response>, over: { maxRetries?: number } = {}) {
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const rec = { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> };
    requests.push(rec);
    return responder(rec);
  }) as typeof fetch;
  const client = new AnthropicModelClient({ apiKey: 'sk-ant-chave-secreta-de-teste-123456', model: 'claude-sonnet-5-5', fetch: fetchImpl, maxRetries: over.maxRetries ?? 0 });
  return { client, requests };
}

const baseReq = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  system: 'Sistema',
  messages: [{ role: 'user', content: 'Oi' }],
  tools: toolSpecs('worktree'),
  maxTokens: 2048,
  signal: new AbortController().signal,
  ...over,
});

describe('AnthropicModelClient: respostas', () => {
  it('texto: devolve texto, parada end_turn e uso com cache', async () => {
    const { client } = make(() => sse([start(), ...text(0, 'Olá, mundo'), ...end('end_turn')]));
    const t = await client.turn(baseReq());
    expect(t.text).toBe('Olá, mundo');
    expect(t.stopReason).toBe('end_turn');
    expect(t.toolCalls).toEqual([]);
    expect(t.usage).toEqual({ model: 'claude-sonnet-5-5', inputTokens: 100, outputTokens: 42, cacheReadTokens: 50, cacheWriteTokens: 10 });
    expect(Array.isArray(t.raw)).toBe(true);
  });

  it('tool_use: extrai id, nome e entrada JSON', async () => {
    const { client } = make(() => sse([start(), ...text(0, 'vou ler'), ...toolUse(1, 'toolu_1', 'read_file', '{"path":"a.txt","limit":5}'), ...end('tool_use')]));
    const t = await client.turn(baseReq());
    expect(t.stopReason).toBe('tool_use');
    expect(t.toolCalls).toEqual([{ id: 'toolu_1', name: 'read_file', input: { path: 'a.txt', limit: 5 } }]);
  });

  it('recusa: devolve a categoria informada pelo provedor', async () => {
    const { client } = make(() => sse([start(), ...end('refusal', { stop_details: { type: 'refusal', category: 'cyber', explanation: 'x' } })]));
    const t = await client.turn(baseReq());
    expect(t.stopReason).toBe('refusal');
    expect(t.refusalCategory).toBe('cyber');
  });

  it('max_tokens e pause_turn são mapeados', async () => {
    const a = make(() => sse([start(), ...text(0, 'cort'), ...end('max_tokens')]));
    expect((await a.client.turn(baseReq())).stopReason).toBe('max_tokens');
    const b = make(() => sse([start(), ...text(0, '...'), ...end('pause_turn')]));
    expect((await b.client.turn(baseReq())).stopReason).toBe('pause_turn');
  });
});

describe('AnthropicModelClient: requisição enviada', () => {
  it('usa a chave só no cabeçalho, modelo/sistema/max_tokens corretos e cache automático', async () => {
    const { client, requests } = make(() => sse([start(), ...text(0, 'ok'), ...end('end_turn')]));
    await client.turn(baseReq());
    const r = requests[0]!;
    expect(r.url).toContain('/v1/messages');
    // O SDK 1.x envia a chave em `authorization: Bearer`; versões anteriores usavam `x-api-key`. Qualquer um serve, desde que só no cabeçalho.
    expect(r.headers.get('x-api-key') ?? r.headers.get('authorization')).toContain('sk-ant-chave-secreta-de-teste-123456');
    expect(r.body.model).toBe('claude-sonnet-5-5');
    expect(r.body.system).toBe('Sistema');
    expect(r.body.max_tokens).toBe(2048);
    expect(r.body.stream).toBe(true);
    expect(r.body.cache_control).toEqual({ type: 'ephemeral' });
    expect(JSON.stringify(r.body)).not.toContain('chave-secreta');
  });

  it('ferramentas: strict, additionalProperties:false e sem palavras-chave que o modo estrito não aceita', async () => {
    const { client, requests } = make(() => sse([start(), ...text(0, 'ok'), ...end('end_turn')]));
    await client.turn(baseReq());
    const tools = requests[0]!.body.tools as Array<{ name: string; strict: boolean; description: string; input_schema: { additionalProperties: boolean; properties: Record<string, Record<string, unknown>>; required: string[] } }>;
    expect(tools.map((t) => t.name).sort()).toEqual(toolSpecs('worktree').map((t) => t.name).sort());
    for (const t of tools) {
      expect(t.strict).toBe(true);
      expect(t.input_schema.additionalProperties).toBe(false);
      for (const p of Object.values(t.input_schema.properties)) {
        expect(p).not.toHaveProperty('minimum');
        expect(p).not.toHaveProperty('maximum');
        expect(p).not.toHaveProperty('maxLength');
      }
    }
    const read = tools.find((t) => t.name === 'read_file')!;
    expect(read.input_schema.required).toEqual(['path']);
    expect(requests[0]!.body.tool_choice).toEqual({ type: 'auto' });
  });

  it('mensagens: resultados de ferramentas viram UMA mensagem de usuário; o conteúdo do assistente volta intacto', async () => {
    const { client, requests } = make(() => sse([start(), ...text(0, 'ok'), ...end('end_turn')]));
    const raw = [
      { type: 'thinking', thinking: 'pensando', signature: 'sig-abc' },
      { type: 'tool_use', id: 'toolu_1', name: 'list_dir', input: { path: '.' } },
      { type: 'tool_use', id: 'toolu_2', name: 'read_file', input: { path: 'a' } },
    ];
    await client.turn(
      baseReq({
        messages: [
          { role: 'user', content: 'tarefa' },
          { role: 'assistant', raw },
          { role: 'tool_results', results: [{ toolCallId: 'toolu_1', content: 'a.txt', isError: false }, { toolCallId: 'toolu_2', content: 'falhou', isError: true }] },
        ],
      }),
    );
    const msgs = requests[0]!.body.messages as Array<{ role: string; content: unknown }>;
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toEqual({ role: 'user', content: 'tarefa' });
    expect(msgs[1]).toEqual({ role: 'assistant', content: raw });
    expect(msgs[2]!.role).toBe('user');
    expect(msgs[2]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt' },
      { type: 'tool_result', tool_use_id: 'toolu_2', content: 'falhou', is_error: true },
    ]);
  });
});

describe('AnthropicModelClient: falhas', () => {
  it('401: mensagem clara, sem vazar a chave', async () => {
    const { client } = make(() => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key sk-ant-chave-secreta-de-teste-123456' } }), { status: 401, headers: { 'content-type': 'application/json' } }));
    const err = await client.turn(baseReq()).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/chave de api/i);
    expect((err as Error).message).not.toContain('chave-secreta');
  });

  it('429: mensagem de limite de taxa', async () => {
    const { client } = make(() => new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' } }));
    const err = (await client.turn(baseReq()).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/limite de taxa/i);
  });

  it('erro temporário (529) é repetido pelo SDK e depois dá certo', async () => {
    let n = 0;
    const { client, requests } = make(
      () => (++n === 1 ? new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }), { status: 529, headers: { 'content-type': 'application/json', 'retry-after-ms': '10' } }) : sse([start(), ...text(0, 'ok'), ...end('end_turn')])),
      { maxRetries: 2 },
    );
    const t = await client.turn(baseReq());
    expect(t.text).toBe('ok');
    expect(requests).toHaveLength(2);
  });

  it('cancelamento: rejeita e não deixa a requisição pendurada', async () => {
    const ac = new AbortController();
    const { client } = make(
      (req) => new Promise<Response>((_res, rej) => {
        void req;
        ac.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      }),
    );
    setTimeout(() => ac.abort(), 30);
    await expect(client.turn(baseReq({ signal: ac.signal }))).rejects.toThrow(/cancelado/i);
  });
});
