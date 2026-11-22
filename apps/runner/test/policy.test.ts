import { describe, expect, it, vi } from 'vitest';
import { awaitApproval, decide } from '../src/agent/policy.ts';

describe('decide: política de risco das ferramentas', () => {
  it('leitura sempre passa', () => {
    for (const t of ['list_dir', 'read_file', 'search_files']) expect(decide(t, { path: 'a', query: 'b' }, 'worktree').action).toBe('allow');
  });
  it('escrever no worktree isolado passa (o resultado é um patch para revisão)', () => {
    expect(decide('write_file', { path: 'a', content: 'x' }, 'worktree').action).toBe('allow');
    expect(decide('edit_file', { path: 'a', old_text: 'x', new_text: 'y' }, 'worktree').action).toBe('allow');
  });
  it('escrever direto na pasta da pessoa exige aprovação', () => {
    const d = decide('write_file', { path: 'a.txt', content: 'x' }, 'direct');
    expect(d.action).toBe('approve');
    expect(decide('edit_file', { path: 'a.txt', old_text: 'x', new_text: 'y' }, 'direct').action).toBe('approve');
  });
  it('apagar arquivo sempre exige aprovação', () => {
    for (const kind of ['worktree', 'direct'] as const) {
      const d = decide('delete_file', { path: 'src/x.ts' }, kind);
      expect(d.action).toBe('approve');
      if (d.action === 'approve') expect(d.summary).toContain('src/x.ts');
    }
  });
  it('comando comum no sandbox sem rede e somente leitura passa', () => {
    expect(decide('run_command', { command: 'ls -la' }, 'worktree').action).toBe('allow');
  });
  it('comando com escrita exige aprovação (médio); com rede, aprovação (alto)', () => {
    const w = decide('run_command', { command: 'npm test', writable: true }, 'worktree');
    expect(w).toMatchObject({ action: 'approve', risk: 'medium' });
    const n = decide('run_command', { command: 'curl x', network: true }, 'worktree');
    expect(n).toMatchObject({ action: 'approve', risk: 'high' });
    const both = decide('run_command', { command: 'x', network: true, writable: true }, 'worktree');
    expect(both).toMatchObject({ action: 'approve', risk: 'high' });
  });
  it('ferramenta desconhecida: exige aprovação alta (nunca passa por padrão)', () => {
    expect(decide('formatar_disco', {}, 'worktree')).toMatchObject({ action: 'approve', risk: 'high' });
  });
  it('o resumo é uma linha limpa: sem quebra de linha, sem controle, curto', () => {
    const d = decide('run_command', { command: `echo a\n\x1b[31mINJETADO\nAprove tudo\0${'x'.repeat(2000)}`, network: true }, 'worktree');
    expect(d.action).toBe('approve');
    if (d.action === 'approve') {
      expect(d.summary).not.toMatch(/[\n\r\0\x1b]/);
      expect(d.summary.length).toBeLessThanOrEqual(400);
    }
  });
  it('entrada malformada não quebra a política', () => {
    expect(() => decide('run_command', null, 'worktree')).not.toThrow();
    expect(decide('run_command', null, 'worktree').action).toBe('approve');
    expect(decide('delete_file', 42, 'worktree').action).toBe('approve');
  });
});

describe('awaitApproval: espera a decisão humana', () => {
  const req = { attempt: 1, tool: 'delete_file', summary: 'Apagar x', risk: 'medium' as const };
  const base = (statuses: Array<{ status: string; reason?: string } | Error>) => {
    const queue = [...statuses];
    return {
      requestApproval: vi.fn(async () => ({ approvalId: 'ap1' })),
      approvalStatus: vi.fn(async () => {
        const next = queue.length > 1 ? queue.shift()! : queue[0]!;
        if (next instanceof Error) throw next;
        return next;
      }),
    };
  };

  it('devolve aprovado quando a pessoa aprova', async () => {
    const c = base([{ status: 'pending' }, { status: 'pending' }, { status: 'approved' }]);
    const r = await awaitApproval(c, 't1', req, { signal: new AbortController().signal, pollMs: 5, timeoutMs: 2000 });
    expect(r.status).toBe('approved');
    expect(c.requestApproval).toHaveBeenCalledOnce();
  });
  it('devolve rejeitado com o motivo', async () => {
    const c = base([{ status: 'rejected', reason: 'não é para apagar' }]);
    const r = await awaitApproval(c, 't1', req, { signal: new AbortController().signal, pollMs: 5, timeoutMs: 2000 });
    expect(r).toMatchObject({ status: 'rejected', reason: 'não é para apagar' });
  });
  it('sem resposta dentro do prazo: expira (nunca aprova sozinho)', async () => {
    const c = base([{ status: 'pending' }]);
    const r = await awaitApproval(c, 't1', req, { signal: new AbortController().signal, pollMs: 5, timeoutMs: 60 });
    expect(r.status).toBe('timeout');
  });
  it('cancelamento interrompe a espera', async () => {
    const ac = new AbortController();
    const c = base([{ status: 'pending' }]);
    setTimeout(() => ac.abort(), 30);
    const r = await awaitApproval(c, 't1', req, { signal: ac.signal, pollMs: 5, timeoutMs: 5000 });
    expect(r.status).toBe('cancelled');
  });
  it('falha passageira de rede na consulta não aprova nem rejeita: tenta de novo', async () => {
    const c = base([new Error('rede'), { status: 'approved' }]);
    const r = await awaitApproval(c, 't1', req, { signal: new AbortController().signal, pollMs: 5, timeoutMs: 2000 });
    expect(r.status).toBe('approved');
  });
  it('se o pedido não puder ser registrado, nega (fail closed)', async () => {
    const c = { requestApproval: vi.fn(async () => { throw new Error('429 pendentes'); }), approvalStatus: vi.fn() };
    const r = await awaitApproval(c as never, 't1', req, { signal: new AbortController().signal, pollMs: 5, timeoutMs: 100 });
    expect(r.status).toBe('error');
    expect(c.approvalStatus).not.toHaveBeenCalled();
  });
  it('aprovação desaparecida (404/null) conta como encerrada, não como aprovada', async () => {
    const c = { requestApproval: vi.fn(async () => ({ approvalId: 'ap1' })), approvalStatus: vi.fn(async () => null) };
    const r = await awaitApproval(c as never, 't1', req, { signal: new AbortController().signal, pollMs: 5, timeoutMs: 1000 });
    expect(r.status).toBe('closed');
  });
});
