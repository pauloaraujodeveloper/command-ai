// Falso "codex" para testes: imita `codex exec --json` (JSONL). Os tipos de evento thread.started, turn.started e error foram
// OBSERVADOS no CLI 0.171.0 sem login; os itens (agent_message, file_change, command_execution, mcp_tool_call) e turn.completed
// seguem a documentação do Codex e ainda NÃO foram conferidos contra o CLI real (falta login). Registra argv/cwd/env/stdin em FAKE_DUMP.
const fs = require('node:fs');
const path = require('node:path');

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', run);
if (process.stdin.isTTY) run();

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const item = (type, extra, phase = 'item.completed') => out({ type: phase, item: { id: 'item_' + Math.random().toString(36).slice(2, 7), type, ...extra } });

function run() {
  const mode = process.env.FAKE_MODE || 'ok';
  if (process.env.FAKE_DUMP) fs.writeFileSync(process.env.FAKE_DUMP, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env, envKeys: Object.keys(process.env), stdin, pid: process.pid }));
  out({ type: 'thread.started', thread_id: 'th_fake' });
  out({ type: 'turn.started' });

  if (mode === 'hang') return void setInterval(() => undefined, 1000);
  if (mode === 'noresult') return void process.exit(0);
  if (mode === 'autherror') {
    out({ type: 'error', message: 'Reconnecting... 1/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header)' });
    out({ type: 'error', message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' });
    return void process.exit(101);
  }
  if (mode === 'fail') {
    out({ type: 'turn.failed', error: { message: 'Limite de uso do plano atingido. Volta em 3 horas.' } });
    return void process.exit(1);
  }
  if (mode === 'shell') item('command_execution', { command: 'powershell -c "whoami"', aggregated_output: '', exit_code: null, status: 'in_progress' }, 'item.started');
  if (mode === 'websearch') item('web_search', { query: 'segredos' });
  if (mode === 'othermcp') item('mcp_tool_call', { server: 'outro_servidor', tool: 'x', arguments: {}, status: 'in_progress' }, 'item.started');
  if (mode === 'outside') item('file_change', { changes: [{ path: path.join(process.cwd(), '..', 'FORA.txt'), kind: 'add' }], status: 'completed' });
  if (mode === 'garbage') {
    process.stdout.write('texto solto\n');
    process.stdout.write('{"type":"coisa_nova","x":1}\n');
  }
  if (mode === 'mcp') return void runMcp();

  item('reasoning', { text: 'pensando...' });
  item('agent_message', { text: 'Vou criar a nota.' });
  const target = path.join(process.cwd(), process.env.FAKE_FILE || 'NOTA.md');
  fs.writeFileSync(target, '# nota\n');
  item('file_change', { changes: [{ path: target, kind: 'add' }], status: 'completed' });
  item('agent_message', { text: 'Feito: criei NOTA.md.' });
  out({ type: 'turn.completed', usage: { input_tokens: 12000, cached_input_tokens: 9000, output_tokens: 300 } });
}

// Cliente MCP (HTTP) como o Codex: URL e nome da variável do token vêm de -c mcp_servers.command_ai.*
async function runMcp() {
  const argv = process.argv.slice(2);
  const cfg = {};
  for (let i = 0; i < argv.length; i++) if (argv[i] === '-c' && argv[i + 1].startsWith('mcp_servers.command_ai.')) cfg[argv[i + 1].split('=')[0].slice('mcp_servers.command_ai.'.length)] = JSON.parse(argv[i + 1].split('=').slice(1).join('='));
  const token = process.env[cfg.bearer_token_env_var];
  const rpc = async (id, method, params) => {
    const r = await fetch(cfg.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    return r.status === 202 ? null : await r.json();
  };
  const log = { cfg, tokenSeen: !!token };
  log.init = (await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-codex', version: '1' } })).result;
  log.list = (await rpc(2, 'tools/list')).result.tools.map((t) => t.name);
  log.calls = [];
  let n = 3;
  for (const c of JSON.parse(process.env.FAKE_MCP_CALLS || '[]')) {
    item('mcp_tool_call', { server: 'command_ai', tool: c.name, arguments: c.args, status: 'in_progress' }, 'item.started');
    const r = await rpc(n++, 'tools/call', { name: c.name, arguments: c.args });
    log.calls.push({ name: c.name, result: r.result ?? r.error });
    item('mcp_tool_call', { server: 'command_ai', tool: c.name, arguments: c.args, status: r.result && !r.result.isError ? 'completed' : 'failed', result: r.result ?? null, error: r.error ? { message: r.error.message } : null });
  }
  if (process.env.FAKE_MCP_OUT) fs.writeFileSync(process.env.FAKE_MCP_OUT, JSON.stringify(log));
  item('agent_message', { text: 'MCP usado.' });
  out({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
}
