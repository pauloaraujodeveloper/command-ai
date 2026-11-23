import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgent } from '../src/agent/loop.ts';
import { OpenAiCompatModelClient } from '../src/agent/openai-client.ts';
import { toolSpecs } from '../src/agent/tools.ts';
import type { ModelRequest } from '../src/agent/types.ts';

const KEYVAL = 'sk-chave-secreta-de-teste-abcdef123456';

function reply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
const completion = (message: Record<string, unknown>, finish = 'stop', usage: Record<string, unknown> = { prompt_tokens: 100, completion_tokens: 20 }) => ({
  id: 'c1',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: null, ...message }, finish_reason: finish }],
  usage,
});
const toolCall = (id: string, name: string, args: unknown) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });

type Rec = { url: string; headers: Headers; body: Record<string, any> };
function make(responder: (r: Rec, n: number) => Response | Promise<Response>, over: Partial<ConstructorParameters<typeof OpenAiCompatModelClient>[0]> = {}) {
  const requests: Rec[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const rec = { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? '{}')) };
    requests.push(rec);
    return responder(rec, requests.length);
  }) as typeof fetch;
  const client = new OpenAiCompatModelClient({ kind: 'openai', apiKey: KEYVAL, baseURL: 'https://api.example.test/v1', model: 'gpt-x', fetch: fetchImpl, maxRetries: 0, retryDelayMs: 1, ...over });
  return { client, requests };
}
const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  system: 'Sistema',
  messages: [{ role: 'user', content: 'Oi' }],
  tools: toolSpecs('worktree'),
  maxTokens: 1024,
  signal: new AbortController().signal,
  ...over,
});

describe('OpenAiCompatModelClient: respostas', () => {
  it('texto: devolve o texto, parada end_turn e uso', async () => {
    const { client } = make(() => reply(completion({ content: 'Olá!' })));
    const t = await client.turn(req());
    expect(t.text).toBe('Olá!');
    expect(t.stopReason).toBe('end_turn');
    expect(t.toolCalls).toEqual([]);
    expect(t.usage).toEqual({ model: 'gpt-x', inputTokens: 100, outputTokens: 20 });
  });

  it('chamadas de ferramenta: converte os argumentos JSON em objeto, mantém a ordem e os ids', async () => {
    const { client } = make(() =>
      reply(completion({ content: 'lendo', tool_calls: [toolCall('call_1', 'read_file', { path: 'a.txt' }), toolCall('call_2', 'list_dir', { path: '.' })] }, 'tool_calls')),
    );
    const t = await client.turn(req());
    expect(t.stopReason).toBe('tool_use');
    expect(t.toolCalls).toEqual([
      { id: 'call_1', name: 'read_file', input: { path: 'a.txt' } },
      { id: 'call_2', name: 'list_dir', input: { path: '.' } },
    ]);
  });

  it('argumentos que não são JSON válido não derrubam: viram uma entrada que o Runner recusa', async () => {
    const { client } = make(() => reply(completion({ tool_calls: [toolCall('c1', 'read_file', '{"path": "a.txt"')] }, 'tool_calls')));
    const t = await client.turn(req());
    expect(t.toolCalls).toHaveLength(1);
    expect(typeof t.toolCalls[0]!.input).toBe('string'); // validateInput recusa e o modelo recebe INVALID_INPUT
  });

  it('motivos de parada: length vira max_tokens, content_filter vira recusa, tool_calls sem finish ainda é uso de ferramenta', async () => {
    expect((await make(() => reply(completion({ content: 'cort' }, 'length'))).client.turn(req())).stopReason).toBe('max_tokens');
    const refusal = await make(() => reply(completion({ content: '' }, 'content_filter'))).client.turn(req());
    expect(refusal.stopReason).toBe('refusal');
    expect(refusal.refusalCategory).toBe('content_filter');
    const odd = await make(() => reply(completion({ tool_calls: [toolCall('c', 'list_dir', { path: '.' })] }, 'stop'))).client.turn(req());
    expect(odd.stopReason).toBe('tool_use'); // alguns servidores compatíveis respondem "stop" com tool_calls
  });

  it('uso com cache: OpenAI (cached_tokens) e DeepSeek (prompt_cache_hit_tokens) separam o que veio do cache', async () => {
    const o = await make(() => reply(completion({ content: 'x' }, 'stop', { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 800 } }))).client.turn(req());
    expect(o.usage).toMatchObject({ inputTokens: 200, outputTokens: 10, cacheReadTokens: 800 });
    const d = await make(() => reply(completion({ content: 'x' }, 'stop', { prompt_tokens: 500, completion_tokens: 5, prompt_cache_hit_tokens: 300, prompt_cache_miss_tokens: 200 }))).client.turn(req());
    expect(d.usage).toMatchObject({ inputTokens: 200, outputTokens: 5, cacheReadTokens: 300 });
  });

  it('servidor sem campo de uso (comum em modelos locais): zera em vez de quebrar', async () => {
    const t = await make(() => reply({ choices: [{ message: { role: 'assistant', content: 'oi' }, finish_reason: 'stop' }] })).client.turn(req());
    expect(t.usage).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it('resposta sem escolhas é erro claro', async () => {
    await expect(make(() => reply({ choices: [] })).client.turn(req())).rejects.toThrow(/sem resposta|inesperada/i);
  });
});

describe('OpenAiCompatModelClient: requisição', () => {
  it('formato do Chat Completions: sistema, ferramentas como function, auth por Bearer, teto de tokens', async () => {
    const { client, requests } = make(() => reply(completion({ content: 'ok' })), { kind: 'openai' });
    await client.turn(req());
    const r = requests[0]!;
    expect(r.url).toBe('https://api.example.test/v1/chat/completions');
    expect(r.headers.get('authorization')).toBe(`Bearer ${KEYVAL}`);
    expect(r.body.model).toBe('gpt-x');
    expect(r.body.messages[0]).toEqual({ role: 'system', content: 'Sistema' });
    expect(r.body.messages[1]).toEqual({ role: 'user', content: 'Oi' });
    expect(r.body.max_completion_tokens).toBe(1024); // OpenAI moderna
    expect(r.body).not.toHaveProperty('max_tokens');
    expect(r.body.tool_choice).toBe('auto');
    const tools = r.body.tools as Array<{ type: string; function: { name: string; description: string; parameters: { type: string; additionalProperties: boolean; properties: Record<string, Record<string, unknown>> } } }>;
    expect(tools.map((t) => t.function.name).sort()).toEqual(toolSpecs('worktree').map((t) => t.name).sort());
    for (const t of tools) {
      expect(t.type).toBe('function');
      expect(t.function.parameters.type).toBe('object');
      for (const p of Object.values(t.function.parameters.properties)) {
        expect(p).not.toHaveProperty('maxLength');
        expect(p).not.toHaveProperty('minimum');
      }
    }
    expect(JSON.stringify(r.body)).not.toContain('chave-secreta');
  });

  it('DeepSeek e Ollama usam max_tokens; Ollama não envia Authorization', async () => {
    const ds = make(() => reply(completion({ content: 'ok' })), { kind: 'deepseek', baseURL: 'https://api.deepseek.test' });
    await ds.client.turn(req());
    expect(ds.requests[0]!.body.max_tokens).toBe(1024);
    expect(ds.requests[0]!.url).toBe('https://api.deepseek.test/chat/completions');
    expect(ds.requests[0]!.headers.get('authorization')).toBe(`Bearer ${KEYVAL}`);
    const ol = make(() => reply(completion({ content: 'ok' })), { kind: 'ollama', apiKey: undefined, baseURL: 'http://127.0.0.1:11434/v1/' });
    await ol.client.turn(req());
    expect(ol.requests[0]!.url).toBe('http://127.0.0.1:11434/v1/chat/completions'); // barra final não duplica
    expect(ol.requests[0]!.headers.get('authorization')).toBeNull();
  });

  it('sem ferramentas, não envia tools nem tool_choice', async () => {
    const { client, requests } = make(() => reply(completion({ content: 'ok' })));
    await client.turn(req({ tools: [] }));
    expect(requests[0]!.body).not.toHaveProperty('tools');
    expect(requests[0]!.body).not.toHaveProperty('tool_choice');
  });

  it('histórico: o assistente volta como veio e cada resultado de ferramenta é uma mensagem role=tool', async () => {
    const { client, requests } = make(() => reply(completion({ content: 'ok' })));
    const assistant = { role: 'assistant', content: null, tool_calls: [toolCall('call_1', 'list_dir', { path: '.' }), toolCall('call_2', 'read_file', { path: 'x' })] };
    await client.turn(
      req({
        messages: [
          { role: 'user', content: 'tarefa' },
          { role: 'assistant', raw: assistant },
          { role: 'tool_results', results: [{ toolCallId: 'call_1', content: 'a.txt', isError: false }, { toolCallId: 'call_2', content: 'não existe', isError: true }] },
        ],
      }),
    );
    const m = requests[0]!.body.messages as Array<Record<string, unknown>>;
    expect(m[2]).toEqual(assistant);
    expect(m[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'a.txt' });
    expect(m[4]).toMatchObject({ role: 'tool', tool_call_id: 'call_2' });
    expect(String(m[4]!.content)).toMatch(/^ERRO/); // sem is_error na API: o erro vai no texto
    expect(String(m[4]!.content)).toContain('não existe');
  });

  it('o raw devolvido pelo cliente é a mensagem do assistente (reenviável) sem campos de raciocínio internos', async () => {
    const { client } = make(() => reply(completion({ content: 'x', reasoning_content: 'pensamento interno', tool_calls: [toolCall('c1', 'list_dir', { path: '.' })] }, 'tool_calls')));
    const t = await client.turn(req());
    expect(t.raw).toEqual({ role: 'assistant', content: 'x', tool_calls: [toolCall('c1', 'list_dir', { path: '.' })] });
  });
});

describe('OpenAiCompatModelClient: falhas', () => {
  it('401: mensagem clara, sem a chave', async () => {
    const { client } = make(() => reply({ error: { message: `Incorrect API key provided: ${KEYVAL}` } }, 401));
    const err = (await client.turn(req()).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/chave de api/i);
    expect(err.message).not.toContain('chave-secreta');
  });

  it('429 e 5xx são repetidos (respeitando Retry-After) e depois dá certo', async () => {
    const { client, requests } = make((_r, n) => (n === 1 ? reply({ error: {} }, 429, { 'retry-after': '0' }) : n === 2 ? reply({ error: {} }, 503) : reply(completion({ content: 'ok' }))), { maxRetries: 3 });
    const t = await client.turn(req());
    expect(t.text).toBe('ok');
    expect(requests).toHaveLength(3);
  });

  it('esgotadas as tentativas, o erro diz o que o provedor respondeu', async () => {
    const { client, requests } = make(() => reply({ error: {} }, 500), { maxRetries: 2 });
    await expect(client.turn(req())).rejects.toThrow(/500/);
    expect(requests).toHaveLength(3);
  });

  it('400 não é repetido e mostra o motivo (sem a chave)', async () => {
    const { client, requests } = make(() => reply({ error: { message: `modelo inválido ${KEYVAL}` } }, 400), { maxRetries: 3 });
    const err = (await client.turn(req()).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/400/);
    expect(err.message).toContain('modelo inválido');
    expect(err.message).not.toContain('chave-secreta');
    expect(requests).toHaveLength(1);
  });

  it('falha de rede é repetida e depois reportada sem detalhes sensíveis', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      throw new TypeError(`fetch failed ${KEYVAL}`);
    }) as unknown as typeof fetch;
    const client = new OpenAiCompatModelClient({ kind: 'openai', apiKey: KEYVAL, baseURL: 'https://x.test/v1', model: 'm', fetch: fetchImpl, maxRetries: 1, retryDelayMs: 1 });
    const err = (await client.turn(req()).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/rede/i);
    expect(err.message).not.toContain('chave-secreta');
    expect(n).toBe(2);
  });

  it('cancelamento interrompe, inclusive durante a espera entre tentativas', async () => {
    const ac = new AbortController();
    const { client } = make(
      () => new Promise<Response>((_res, rej) => ac.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))),
      { maxRetries: 3 },
    );
    setTimeout(() => ac.abort(), 30);
    await expect(client.turn(req({ signal: ac.signal }))).rejects.toThrow(/cancelado/i);
  });
});

/* ---- integração: servidor HTTP falso que fala o protocolo Chat Completions, laço do agente de verdade ---- */
describe('laço do agente contra um servidor compatível com a API da OpenAI', () => {
  let server: Server | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const readBody = (r: IncomingMessage) =>
    new Promise<Record<string, any>>((resolve) => {
      let s = '';
      r.on('data', (d) => (s += d));
      r.on('end', () => resolve(JSON.parse(s)));
    });

  it('várias interações: lista, escreve um arquivo e conclui; o servidor recebe os resultados das ferramentas', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ca-oai-'));
    const seen: Array<Record<string, any>> = [];
    const auth: Array<string | undefined> = [];
    server = createServer(async (rq, rs) => {
      auth.push(rq.headers.authorization);
      const body = await readBody(rq);
      seen.push(body);
      const n = seen.length;
      const msg =
        n === 1
          ? { content: 'Vou listar.', tool_calls: [toolCall('call_a', 'list_dir', { path: '.' })] }
          : n === 2
            ? { content: null, tool_calls: [toolCall('call_b', 'write_file', { path: 'NOTAS.md', content: '# Notas\n' })] }
            : { content: 'Pronto: criei NOTAS.md.' };
      rs.setHeader('content-type', 'application/json');
      rs.end(JSON.stringify(completion(msg, n < 3 ? 'tool_calls' : 'stop', { prompt_tokens: 100 * n, completion_tokens: 10 })));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

    const model = new OpenAiCompatModelClient({ kind: 'ollama', baseURL, model: 'llama-local' });
    const usage = vi.fn(async (_t: string, _b: unknown) => ({ applied: true, cancel: false }));
    const result = await runAgent({
      model,
      workspace: { root: dir, kind: 'worktree' },
      client: { usage, requestApproval: async () => ({ approvalId: 'x' }), approvalStatus: async () => ({ status: 'approved' }) },
      taskId: 't1',
      attempt: 1,
      system: 'sistema',
      prompt: 'Crie as notas',
      emit: () => undefined,
      signal: new AbortController().signal,
      limits: { maxTurns: 6, maxTotalTokens: 100_000, timeoutMs: 20_000, maxTokensPerTurn: 512, maxToolOutputBytes: 100_000 },
    });

    expect(result.output).toBe('Pronto: criei NOTAS.md.');
    expect(result.turns).toBe(3);
    expect(readFileSync(join(dir, 'NOTAS.md'), 'utf8')).toBe('# Notas\n');
    // o 2º pedido carrega o resultado de list_dir como mensagem role=tool com o mesmo id; o 3º, o de write_file
    const tool2 = seen[1]!.messages.filter((m: any) => m.role === 'tool');
    expect(tool2).toHaveLength(1);
    expect(tool2[0]).toMatchObject({ tool_call_id: 'call_a' });
    expect(String(tool2[0].content)).toMatch(/\.|\(pasta vazia\)/);
    const tool3 = seen[2]!.messages.filter((m: any) => m.role === 'tool');
    expect(tool3.map((m: any) => m.tool_call_id)).toEqual(['call_a', 'call_b']);
    expect(String(tool3[1].content)).toContain('NOTAS.md');
    // a mensagem do assistente do turno 1 foi reenviada íntegra
    expect(seen[1]!.messages[2]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_a' }] });
    // uso relatado por turno; Ollama não manda Authorization
    expect(usage).toHaveBeenCalledTimes(3);
    expect(auth.every((a) => a === undefined)).toBe(true);
  });
});
