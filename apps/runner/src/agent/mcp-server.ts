import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CancelledError } from './guarded.ts';
import { toApiObject } from './schema.ts';
import type { ToolSpec } from './types.ts';

export interface McpServerOptions {
  /** Segredo da tarefa: só o Claude Code que o Runner iniciou o conhece. Pelo menos 32 caracteres. */
  token: string;
  /** Ferramentas oferecidas. Qualquer outra é recusada. */
  tools: ToolSpec[];
  /** Executa UMA chamada (com a política e a aprovação do Runner). O sinal é acionado quando o servidor fecha. */
  call: (name: string, args: unknown, signal: AbortSignal) => Promise<{ content: string; isError: boolean }>;
}

export interface McpServer {
  /** Endereço a colocar na configuração do cliente MCP. */
  url: string;
  address: AddressInfo;
  close(): Promise<void>;
}

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 1_000_000;
const sha = (s: string) => createHash('sha256').update(s).digest();

type Rpc = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
const err = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const ok = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });

/**
 * Servidor MCP mínimo (HTTP, sem estado) que expõe ao Claude Code as ferramentas do Runner: comandos no sandbox, apagar arquivo,
 * subtarefas e mensagens. Escuta só em 127.0.0.1, exige o token da tarefa, recusa Host e Origin estranhos e executa uma chamada de cada vez.
 */
export async function startMcpServer(o: McpServerOptions): Promise<McpServer> {
  if (typeof o.token !== 'string' || o.token.length < 32) throw new Error('O token do servidor MCP precisa ter ao menos 32 caracteres');
  const expected = sha(`Bearer ${o.token}`);
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  const listing = o.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: toApiObject(t.inputSchema) }));
  const shutdown = new AbortController();
  let queue: Promise<unknown> = Promise.resolve();
  let port = 0;

  async function handleOne(m: Rpc): Promise<object | null> {
    const hasId = m.id !== undefined && m.id !== null;
    if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') return err(m.id, -32600, 'Requisição inválida');
    if (!hasId) return null; // notificação (por exemplo notifications/initialized): sem resposta

    switch (m.method) {
      case 'initialize': {
        const asked = (m.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        const version = typeof asked === 'string' && SUPPORTED.includes(asked) ? asked : SUPPORTED[1]!;
        return ok(m.id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'command-ai-runner', version: '1.0.0' } });
      }
      case 'ping':
        return ok(m.id, {});
      case 'tools/list':
        return ok(m.id, { tools: listing });
      case 'tools/call': {
        const p = m.params as { name?: unknown; arguments?: unknown } | null;
        if (!p || typeof p !== 'object' || typeof p.name !== 'string') return err(m.id, -32602, 'Parâmetros inválidos');
        if (!byName.has(p.name)) return err(m.id, -32602, `Ferramenta desconhecida: ${p.name.slice(0, 60)}`);
        // Uma chamada de cada vez: o worktree é um só e a aprovação humana é sequencial.
        const run = queue.then(async () => {
          try {
            const r = await o.call(p.name as string, p.arguments ?? {}, shutdown.signal);
            return ok(m.id, { content: [{ type: 'text', text: r.content }], isError: r.isError });
          } catch (e) {
            const text = e instanceof CancelledError ? 'cancelado' : 'Erro interno ao executar a ferramenta';
            return ok(m.id, { content: [{ type: 'text', text }], isError: true });
          }
        });
        queue = run.catch(() => undefined);
        return run;
      }
      default:
        return err(m.id, -32601, `Método não suportado: ${m.method.slice(0, 60)}`);
    }
  }

  async function readBody(req: IncomingMessage): Promise<string | null> {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY) {
      req.resume();
      return null;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) tooBig = true;
      else chunks.push(c as Buffer);
    }
    return tooBig ? null : Buffer.concat(chunks).toString('utf8');
  }

  const send = (res: ServerResponse, status: number, body?: unknown) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(payload === undefined ? {} : { 'content-length': Buffer.byteLength(payload) }), connection: 'close' });
    res.end(payload);
  };

  const server = createServer(async (req, res) => {
    try {
      // Defesa contra DNS rebinding e contra páginas web: só o nome e a porta exatos, e nunca Origin de navegador.
      const host = String(req.headers.host ?? '');
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: 'host não permitido' });
      if (req.headers.origin !== undefined) return send(res, 403, { error: 'origem não permitida' });
      const got = sha(String(req.headers.authorization ?? ''));
      if (!timingSafeEqual(got, expected)) return send(res, 401, { error: 'não autorizado' });
      if (req.url !== '/mcp') return send(res, 404, { error: 'não encontrado' });
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        return send(res, 405, { error: 'método não permitido' });
      }
      if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return send(res, 415, { error: 'use application/json' });

      const raw = await readBody(req);
      if (raw === null) return send(res, 413, { error: 'corpo grande demais' });
      let msg: unknown;
      try {
        msg = JSON.parse(raw);
      } catch {
        return send(res, 200, err(null, -32700, 'JSON inválido'));
      }
      if (Array.isArray(msg)) {
        const out = (await Promise.all(msg.map((m) => handleOne((m ?? {}) as Rpc)))).filter((x): x is object => x !== null);
        return out.length ? send(res, 200, out) : send(res, 202);
      }
      const one = await handleOne((msg ?? {}) as Rpc);
      return one === null ? send(res, 202) : send(res, 200, one);
    } catch {
      if (!res.headersSent) send(res, 500, { error: 'erro interno' });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  port = address.port;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    address,
    async close() {
      shutdown.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
