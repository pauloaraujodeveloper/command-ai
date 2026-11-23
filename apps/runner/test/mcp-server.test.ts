import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { CancelledError } from '../src/agent/guarded.ts';
import { startMcpServer, type McpServer } from '../src/agent/mcp-server.ts';
import { toolSpecs } from '../src/agent/tools.ts';

const TOKEN = 'token-de-teste-bem-longo-0123456789abcdef';
let server: McpServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

type Handler = Parameters<typeof startMcpServer>[0]['call'];
async function start(call: Handler = async () => ({ content: 'ok', isError: false })) {
  server = await startMcpServer({ token: TOKEN, tools: toolSpecs('worktree', { sandbox: true }).filter((t) => ['run_command', 'delete_file'].includes(t.name)), call });
  return server;
}
const rpc = async (body: unknown, headers: Record<string, string> = {}, url?: string) => {
  const res = await fetch(url ?? server!.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? (JSON.parse(text) as any) : undefined };
};
const call = (name: string, args: unknown, id = 1) => rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

describe('servidor MCP do Runner: protocolo', () => {
  it('initialize: devolve a versão pedida (se suportada), capacidade de ferramentas e o nome do servidor', async () => {
    await start();
    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2' } } });
    expect(r.status).toBe(200);
    expect(r.json.id).toBe(1);
    expect(r.json.result.protocolVersion).toBe('2025-06-18');
    expect(r.json.result.capabilities.tools).toBeDefined();
    expect(r.json.result.serverInfo.name).toMatch(/command-ai/);
    const old = await rpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect(['2025-06-18', '2025-03-26', '2024-11-05']).toContain(old.json.result.protocolVersion);
  });

  it('notificações recebem 202 sem corpo; ping responde vazio', async () => {
    await start();
    const n = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(n.status).toBe(202);
    expect(n.json).toBeUndefined();
    const p = await rpc({ jsonrpc: '2.0', id: 9, method: 'ping' });
    expect(p.json).toMatchObject({ id: 9, result: {} });
  });

  it('tools/list: nome, descrição e esquema de cada ferramenta oferecida', async () => {
    await start();
    const r = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const tools = r.json.result.tools as Array<{ name: string; description: string; inputSchema: { type: string; additionalProperties: boolean; required: string[] } }>;
    expect(tools.map((t) => t.name).sort()).toEqual(['delete_file', 'run_command']);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe('object');
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('tools/call: chama o tratador com nome e argumentos e devolve o texto; erro da ferramenta vira isError', async () => {
    const seen: Array<[string, unknown]> = [];
    await start(async (name, args) => (seen.push([name, args]), name === 'delete_file' ? { content: 'não apaguei', isError: true } : { content: 'saída do comando', isError: false }));
    const ok = await call('run_command', { command: 'ls' });
    expect(ok.json.result).toEqual({ content: [{ type: 'text', text: 'saída do comando' }], isError: false });
    const bad = await call('delete_file', { path: 'x' });
    expect(bad.json.result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'não apaguei' }] });
    expect(seen).toEqual([['run_command', { command: 'ls' }], ['delete_file', { path: 'x' }]]);
  });

  it('o tratador que lança erro não vaza detalhes; cancelamento aparece como "cancelado"', async () => {
    await start(async (name) => {
      if (name === 'delete_file') throw new CancelledError();
      throw new Error('falha interna com C:\\segredo\\caminho e stack');
    });
    const a = await call('run_command', { command: 'x' });
    expect(a.json.result.isError).toBe(true);
    expect(JSON.stringify(a.json)).not.toContain('segredo');
    const b = await call('delete_file', { path: 'x' });
    expect(b.json.result.content[0].text).toMatch(/cancelado/i);
  });

  it('ferramenta que não foi oferecida: erro de parâmetro do protocolo, e o tratador nem é chamado', async () => {
    let calls = 0;
    await start(async () => (calls++, { content: 'x', isError: false }));
    const r = await call('formatar_disco', {});
    expect(r.json.error.code).toBe(-32602);
    expect(calls).toBe(0);
  });

  it('erros JSON-RPC: método desconhecido, JSON inválido, requisição malformada', async () => {
    await start();
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'coisa/estranha' })).json.error.code).toBe(-32601);
    expect((await rpc('{não é json')).json.error.code).toBe(-32700);
    expect((await rpc({ jsonrpc: '1.0', id: 1 })).json.error.code).toBe(-32600);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: 'x' })).json.error.code).toBe(-32602);
  });

  it('lote de mensagens: responde só às que têm id, na ordem', async () => {
    await start();
    const r = await rpc([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);
    expect(Array.isArray(r.json)).toBe(true);
    expect(r.json.map((x: { id: number }) => x.id)).toEqual([1, 2]);
  });

  it('chamadas simultâneas são executadas uma de cada vez (o worktree é um só)', async () => {
    let running = 0;
    let maxRunning = 0;
    await start(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 40));
      running--;
      return { content: 'ok', isError: false };
    });
    await Promise.all([call('run_command', { command: 'a' }, 1), call('run_command', { command: 'b' }, 2), call('run_command', { command: 'c' }, 3)]);
    expect(maxRunning).toBe(1);
  });

  it('close() cancela o que estiver rodando e para de aceitar conexões', async () => {
    let aborted = false;
    const s = await start(
      (_n, _a, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve({ content: 'cancelado', isError: true });
          });
        }),
    );
    const url = s.url;
    const pending = call('run_command', { command: 'dorme' });
    await new Promise((r) => setTimeout(r, 100));
    await s.close();
    server = undefined;
    expect(aborted).toBe(true);
    await pending.catch(() => undefined);
    await expect(fetch(url, { method: 'POST', body: '{}' })).rejects.toThrow();
  });
});

describe('servidor MCP do Runner: segurança', () => {
  it('só escuta em 127.0.0.1', async () => {
    const s = await start();
    expect(new URL(s.url).hostname).toBe('127.0.0.1');
    expect(s.address.address).toBe('127.0.0.1');
  });

  it('exige o token da tarefa: sem ele, errado ou com outro esquema, 401 e o tratador não roda', async () => {
    let calls = 0;
    await start(async () => (calls++, { content: 'x', isError: false }));
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_command', arguments: { command: 'x' } } };
    for (const h of [{ authorization: '' }, { authorization: 'Bearer errado' }, { authorization: `Basic ${TOKEN}` }, { authorization: `Bearer ${TOKEN}x` }]) {
      expect((await rpc(body, h)).status, JSON.stringify(h)).toBe(401);
    }
    const noHeader = await fetch(server!.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(noHeader.status).toBe(401);
    expect(calls).toBe(0);
  });

  it('recusa Host de outro nome (defesa contra DNS rebinding) mesmo com o token certo', async () => {
    const s = await start();
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(s.url);
      const req = request({ host: '127.0.0.1', port: u.port, path: u.pathname, method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    });
    expect(status).toBe(403);
  });

  it('recusa Origin de navegador (uma página web não fala com o servidor), GET, caminho errado, corpo grande e tipo errado', async () => {
    const s = await start();
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await fetch(s.url, { method: 'GET', headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, {}, `${new URL(s.url).origin}/outro`)).status).toBe(404);
    const big = await fetch(s.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: 'x'.repeat(1_100_000) });
    expect(big.status).toBe(413);
    const wrong = await fetch(s.url, { method: 'POST', headers: { 'content-type': 'text/plain', authorization: `Bearer ${TOKEN}` }, body: '{}' });
    expect(wrong.status).toBe(415);
  });

  it('o token tem tamanho mínimo: token curto é recusado na criação', async () => {
    await expect(startMcpServer({ token: 'curto', tools: [], call: async () => ({ content: '', isError: false }) })).rejects.toThrow(/token/i);
  });
});
