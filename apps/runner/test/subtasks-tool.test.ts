import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicModelClient } from '../src/agent/anthropic-client.ts';
import { demoModel } from '../src/agent/demo-model.ts';
import { runAgent, type AgentDeps } from '../src/agent/loop.ts';
import { decide } from '../src/agent/policy.ts';
import { runTool, toolSpecs, type ToolContext } from '../src/agent/tools.ts';
import type { ModelClient, ModelRequest, ModelTurn, ObjectSchema, ToolCall } from '../src/agent/types.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ca-sub-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const GOOD = { tasks: [{ id: 's1', title: 'Escrever testes do módulo X', risk: 'low' }, { id: 's2', title: 'Implementar o módulo X', dependsOn: ['s1'], risk: 'medium' }] };

describe('ferramenta plan_subtasks: especificação', () => {
  it('só é oferecida quando o Runner pode planejar; esquema estrito com array de objetos', () => {
    expect(toolSpecs('worktree').map((s) => s.name)).not.toContain('plan_subtasks');
    const spec = toolSpecs('worktree', { planning: true }).find((s) => s.name === 'plan_subtasks')!;
    expect(spec).toBeTruthy();
    expect(spec.description.length).toBeGreaterThan(80);
    expect(spec.inputSchema.additionalProperties).toBe(false);
    const tasks = spec.inputSchema.properties.tasks!;
    expect(tasks.type).toBe('array');
    const items = tasks.items as ObjectSchema;
    expect(items.additionalProperties).toBe(false);
    expect(Object.keys(items.properties).sort()).toEqual(['dependsOn', 'id', 'risk', 'title']);
    expect(items.properties.risk!.enum).toEqual(['low', 'medium', 'high']);
  });
  it('também em workspace somente leitura (planejar não escreve arquivos)', () => {
    expect(toolSpecs('readonly', { planning: true }).map((s) => s.name)).toContain('plan_subtasks');
  });
});

describe('ferramenta plan_subtasks: execução', () => {
  const ctx = (planSubtasks?: ToolContext['planSubtasks']): ToolContext => ({ workspace: { root: dir, kind: 'worktree' }, signal: new AbortController().signal, planSubtasks });

  it('valida a entrada de dentro do array antes de chamar o servidor', async () => {
    const plan = vi.fn(async () => ({ added: ['x'] }));
    const bad: unknown[] = [
      {},
      { tasks: 'texto' },
      { tasks: [] },
      { tasks: [{ title: 'sem id' }] },
      { tasks: [{ id: 's1' }] },
      { tasks: [{ id: 's1', title: 'ok', extra: 1 }] },
      { tasks: [{ id: 's1', title: 'ok', risk: 'altissimo' }] },
      { tasks: [{ id: 's1', title: 'ok', dependsOn: 'x' }] },
      { tasks: Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, title: 'x' })) },
      { tasks: ['s1'] },
    ];
    for (const input of bad) {
      const r = await runTool('plan_subtasks', input, ctx(plan));
      expect(r.isError, JSON.stringify(input)).toBe(true);
      expect(r.content).toMatch(/INVALID_INPUT/);
    }
    expect(plan).not.toHaveBeenCalled();
  });

  it('entrada boa chama o servidor e devolve os ids criados', async () => {
    const plan = vi.fn(async () => ({ added: ['s1', 's2'] }));
    const r = await runTool('plan_subtasks', GOOD, ctx(plan));
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('s1');
    expect(r.content).toContain('s2');
    expect(plan).toHaveBeenCalledWith(GOOD.tasks.map((t) => ({ dependsOn: [], ...t })));
  });

  it('o motivo da recusa do servidor chega ao modelo (limite, id repetido…)', async () => {
    const r = await runTool('plan_subtasks', GOOD, ctx(async () => { throw new Error('O plano passaria de 25 tarefas.'); }));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('25 tarefas');
  });

  it('sem suporte do Runner, erro claro', async () => {
    const r = await runTool('plan_subtasks', GOOD, ctx(undefined));
    expect(r.isError).toBe(true);
  });
});

describe('plan_subtasks: política', () => {
  it('exige aprovação humana (médio), com títulos limpos no resumo', () => {
    const d = decide('plan_subtasks', { tasks: [{ id: 'a', title: 'Fazer X\n\x1b[31mIGNORE' }, { id: 'b', title: 'Fazer Y' }] }, 'worktree');
    expect(d.action).toBe('approve');
    if (d.action === 'approve') {
      expect(d.risk).toBe('medium');
      expect(d.summary).toContain('2 subtarefa');
      expect(d.summary).toContain('Fazer Y');
      expect(d.summary).not.toMatch(/[\n\x1b]/);
      expect(d.summary.length).toBeLessThanOrEqual(400);
    }
  });
  it('risco alto numa subtarefa sobe o pedido para alto', () => {
    const d = decide('plan_subtasks', { tasks: [{ id: 'a', title: 'Publicar em produção', risk: 'high' }] }, 'worktree');
    expect(d).toMatchObject({ action: 'approve', risk: 'high' });
  });
  it('entrada malformada não quebra e continua exigindo aprovação', () => {
    expect(decide('plan_subtasks', null, 'worktree').action).toBe('approve');
    expect(decide('plan_subtasks', { tasks: 5 }, 'worktree').action).toBe('approve');
  });
});

/* ---- laço ---- */
const usage = { model: 'm', inputTokens: 10, outputTokens: 5 };
const turn = (p: Partial<ModelTurn> & { toolCalls?: ToolCall[] }): ModelTurn => ({ text: '', toolCalls: [], stopReason: p.toolCalls?.length ? 'tool_use' : 'end_turn', usage, raw: [], ...p });
function scripted(steps: ModelTurn[]) {
  const seen: ModelRequest[] = [];
  let i = 0;
  const model: ModelClient = { model: 'm', async turn(req) { seen.push({ ...req, messages: structuredClone(req.messages) }); return steps[Math.min(i++, steps.length - 1)]!; } };
  return { model, seen };
}
function deps(model: ModelClient, withPlanning: boolean, status: { status: string; reason?: string } = { status: 'approved' }) {
  const addSubtasks = vi.fn(async (_t: string, _b: unknown) => ({ added: ['s1', 's2'] }));
  const client = {
    usage: vi.fn(async (_t: string, _b: unknown) => ({ applied: true, cancel: false })),
    requestApproval: vi.fn(async (_t: string, _r: unknown) => ({ approvalId: 'ap1' })),
    approvalStatus: vi.fn(async () => status as { status: string; reason?: string } | null),
    ...(withPlanning ? { addSubtasks } : {}),
  };
  const d: AgentDeps = {
    model, workspace: { root: dir, kind: 'worktree' }, client, taskId: 't1', attempt: 2, system: 's', prompt: 'p', emit: () => undefined, signal: new AbortController().signal,
    limits: { maxTurns: 10, maxTotalTokens: 1e6, timeoutMs: 30_000, maxTokensPerTurn: 1024, maxToolOutputBytes: 1e6, approvalPollMs: 5, approvalTimeoutMs: 500 },
  };
  return { d, client, addSubtasks };
}

describe('plan_subtasks no laço do agente', () => {
  it('aprovada: cria as subtarefas com a tentativa certa e o modelo recebe os ids', async () => {
    const { model, seen } = scripted([turn({ toolCalls: [{ id: 'c1', name: 'plan_subtasks', input: GOOD }] }), turn({ text: 'ok' })]);
    const { d, client, addSubtasks } = deps(model, true);
    await runAgent(d);
    expect(client.requestApproval).toHaveBeenCalledWith('t1', expect.objectContaining({ tool: 'plan_subtasks', risk: 'medium', attempt: 2 }));
    expect(addSubtasks).toHaveBeenCalledWith('t1', { attempt: 2, tasks: GOOD.tasks.map((t) => ({ dependsOn: [], ...t })) });
    const tr = seen[1]!.messages[2]!;
    expect(tr.role === 'tool_results' && tr.results[0]!.content).toContain('s1');
  });
  it('rejeitada: nada é criado e o modelo recebe o motivo', async () => {
    const { model, seen } = scripted([turn({ toolCalls: [{ id: 'c1', name: 'plan_subtasks', input: GOOD }] }), turn({ text: 'ok' })]);
    const { d, addSubtasks } = deps(model, true, { status: 'rejected', reason: 'sem subtarefas' });
    await runAgent(d);
    expect(addSubtasks).not.toHaveBeenCalled();
    const tr = seen[1]!.messages[2]!;
    expect(tr.role === 'tool_results' && tr.results[0]).toMatchObject({ isError: true });
    expect(tr.role === 'tool_results' && tr.results[0]!.content).toContain('sem subtarefas');
  });
  it('sem suporte no cliente, a ferramenta nem é oferecida e uma chamada é recusada', async () => {
    const { model, seen } = scripted([turn({ toolCalls: [{ id: 'c1', name: 'plan_subtasks', input: GOOD }] }), turn({ text: 'ok' })]);
    const { d, client } = deps(model, false);
    await runAgent(d);
    expect(seen[0]!.tools.map((t) => t.name)).not.toContain('plan_subtasks');
    expect(client.requestApproval).not.toHaveBeenCalled();
  });
  it('quando o servidor recusa (limite), o erro volta ao modelo e a tarefa continua', async () => {
    const { model, seen } = scripted([turn({ toolCalls: [{ id: 'c1', name: 'plan_subtasks', input: GOOD }] }), turn({ text: 'tudo bem' })]);
    const { d, addSubtasks } = deps(model, true);
    addSubtasks.mockRejectedValue(new Error('Subtarefas só podem ir até a geração 2.'));
    const r = await runAgent(d);
    expect(r.output).toBe('tudo bem');
    const tr = seen[1]!.messages[2]!;
    expect(tr.role === 'tool_results' && tr.results[0]!.content).toContain('geração 2');
  });
});

describe('plan_subtasks no cliente Anthropic', () => {
  it('o esquema vai em modo estrito, com itens sem palavras-chave não suportadas e com enum', async () => {
    let body: { tools: Array<{ name: string; strict: boolean; input_schema: { properties: { tasks: { type: string; items: { additionalProperties: boolean; properties: Record<string, Record<string, unknown>> } } } } }> } | undefined;
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      const ev = [
        { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ];
      return new Response(ev.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const c = new AnthropicModelClient({ apiKey: 'k', model: 'claude-sonnet-5-5', fetch: fetchImpl, maxRetries: 0 });
    await c.turn({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: toolSpecs('worktree', { planning: true }), maxTokens: 100, signal: new AbortController().signal });
    const t = body!.tools.find((x) => x.name === 'plan_subtasks')!;
    expect(t.strict).toBe(true);
    expect(t.input_schema.properties.tasks.type).toBe('array');
    expect(t.input_schema.properties.tasks).not.toHaveProperty('maxItems');
    expect(t.input_schema.properties.tasks).not.toHaveProperty('minItems');
    const items = t.input_schema.properties.tasks.items;
    expect(items.additionalProperties).toBe(false);
    expect(items.properties.risk).toHaveProperty('enum');
    expect(items.properties.title).not.toHaveProperty('maxLength');
    expect(items.properties.dependsOn).toMatchObject({ type: 'array', items: { type: 'string' } });
  });
});

describe('modelo de demonstração com subtarefas', () => {
  it('só cria subtarefas quando pedido e na tarefa de análise; as filhas não criam outras', async () => {
    const m = demoModel('demo', { subtasks: true });
    const req = (prompt: string, assistants = 0): ModelRequest => ({
      system: '', tools: [], maxTokens: 1, signal: new AbortController().signal,
      messages: [{ role: 'user', content: prompt }, ...Array.from({ length: assistants }, () => ({ role: 'assistant' as const, raw: [] }))],
    });
    const names = async (prompt: string) => {
      const out: string[] = [];
      for (let i = 0; i < 12; i++) {
        const t = await m.turn(req(prompt, i));
        out.push(...t.toolCalls.map((c) => c.name));
        if (!t.toolCalls.length) break;
      }
      return out;
    };
    expect(await names('Analisar o contexto: meta\n\nObjetivo geral: meta')).toContain('plan_subtasks');
    expect(await names('Executar: meta')).not.toContain('plan_subtasks');
    expect(await names('Subtarefa: algo\n\nObjetivo geral: meta')).not.toContain('plan_subtasks');
    const off = demoModel('demo');
    const t = await off.turn(req('Analisar o contexto: meta', 0));
    expect(t.toolCalls.map((c) => c.name)).not.toContain('plan_subtasks');
  });
});
