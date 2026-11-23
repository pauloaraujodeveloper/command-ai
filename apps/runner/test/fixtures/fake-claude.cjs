// Falso "claude" para testes: lê o prompt do stdin, imita o formato stream-json do Claude Code 2.1.x e (conforme FAKE_MODE) escreve um arquivo,
// falha, trava... Registra argumentos, diretório, ambiente e prompt em FAKE_DUMP para o teste conferir.
const fs = require('node:fs');
const path = require('node:path');

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', run);
if (process.stdin.isTTY) run();

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

function run() {
  const mode = process.env.FAKE_MODE || 'ok';
  if (process.env.FAKE_DUMP) {
    fs.writeFileSync(process.env.FAKE_DUMP, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), envKeys: Object.keys(process.env), env: process.env, stdin, pid: process.pid }));
  }
  out({ type: 'system', subtype: 'init', model: 'claude-fake', cwd: process.cwd(), tools: ['Read', 'Write', 'Edit'] });

  if (mode === 'mcp') return void runMcp();
  if (mode === 'hang') return void setInterval(() => undefined, 1000);
  if (mode === 'crash') {
    process.stderr.write('falha interna com a chave sk-ant-abcdefghijklmnop1234567890 no ambiente\n');
    process.exit(2);
  }
  if (mode === 'noresult') return void process.exit(0);
  if (mode === 'garbage') {
    process.stdout.write('isto não é JSON\n');
    process.stdout.write('{"type":"coisa_desconhecida","x":1}\n');
    process.stdout.write('\n');
  }
  if (mode === 'ratelimit') out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1795000000 } });

  if (mode === 'error_result') {
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Limite de uso da assinatura atingido. Volta às 15h.', num_turns: 1, usage: { input_tokens: 5, output_tokens: 1 }, total_cost_usd: 0 });
    return void process.exit(1);
  }

  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Vou criar a nota.' }] } });
  const target = path.join(process.cwd(), process.env.FAKE_FILE || 'NOTA.md');
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: target, content: '# nota\n' } }] } });
  if (mode !== 'readonly') fs.writeFileSync(target, '# nota\n');
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'File created successfully', is_error: false }] } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Feito: criei NOTA.md.' }] } });
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Feito: criei NOTA.md.',
    num_turns: 2,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 4, cache_creation_input_tokens: 2000, cache_read_input_tokens: 8000, output_tokens: 300 },
  });
}

// Imita o Claude Code usando as ferramentas do Runner por MCP (HTTP): lê --mcp-config, fala JSON-RPC e registra o que recebeu em FAKE_MCP_OUT.
async function runMcp() {
  const i = process.argv.indexOf('--mcp-config');
  const cfg = JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8')).mcpServers.command_ai;
  const rpc = async (id, method, params) => {
    const r = await fetch(cfg.url, { method: 'POST', headers: { 'content-type': 'application/json', ...cfg.headers }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    return r.status === 202 ? null : await r.json();
  };
  const log = { url: cfg.url, token: String(cfg.headers.Authorization).slice(7) };
  log.init = (await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } })).result;
  log.list = (await rpc(2, 'tools/list')).result.tools.map((t) => t.name);
  const tools = JSON.parse(process.env.FAKE_MCP_CALLS || '[]');
  log.calls = [];
  let n = 3;
  for (const c of tools) {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'm' + n, name: 'mcp__command_ai__' + c.name, input: c.args }] } });
    const r = await rpc(n++, 'tools/call', { name: c.name, arguments: c.args });
    log.calls.push({ name: c.name, result: r.result ?? r.error });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'm' + (n - 1), content: JSON.stringify(r.result ?? r.error), is_error: !!(r.result && r.result.isError) }] } });
  }
  if (process.env.FAKE_MCP_OUT) fs.writeFileSync(process.env.FAKE_MCP_OUT, JSON.stringify(log));
  out({ type: 'result', subtype: 'success', is_error: false, result: 'MCP usado.', num_turns: 2, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
}
