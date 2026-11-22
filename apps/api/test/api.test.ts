import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { generateTotpSecret, totpCode } from '../src/auth.ts';
import { verifyJob } from '@command-ai/shared/signing';

const SIGNING_KEY = 'api-test-signing-key-long-enough-1234';
const H = { 'x-command-ai': '1', 'content-type': 'application/json' };
const PASSWORD = 'senha-muito-forte-1';

let app: FastifyInstance;

beforeEach(async () => {
  ({ app } = await buildApp({ jobSigningKey: SIGNING_KEY, production: false, logger: false }));
});
afterEach(async () => {
  await app.close();
});

async function register(email: string, orgName = 'Acme') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: H,
    payload: { name: 'Ana', orgName, email, password: PASSWORD },
  });
  const session = res.cookies.find((c) => c.name === 'ca_session');
  return { res, headers: { ...H, cookie: `ca_session=${session?.value ?? ''}` } };
}

async function setupFlow(headers: Record<string, string>) {
  const agent = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      headers,
      payload: { name: 'Auditor', role: 'Auditoria', instructions: 'Audite.', providerKind: 'simulated', model: 'claude-sonnet-5-5', budgetUsd: 5 },
    })
  ).json();
  const project = (
    await app.inject({ method: 'POST', url: '/api/v1/projects', headers, payload: { name: 'Repo', workspacePath: '/work/repo' } })
  ).json();
  return { agent, project };
}

/** Cria e inicia uma execução cujo primeiro passo é de risco alto (gera aprovação na hora). */
async function startHighRisk(headers: Record<string, string>, agentId: string, projectId: string) {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/executions',
    headers,
    payload: { goal: 'Fazer deploy em produção', projectId, agentId },
  });
  expect(created.statusCode).toBe(201);
  const execId: string = created.json().execution.id;
  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/v1/executions/${execId}/plan`,
    headers,
    payload: { tasks: [{ id: 'deploy', title: 'Publicar em produção', agentId, dependsOn: [], risk: 'high' }] },
  });
  expect(patched.statusCode).toBe(200);
  await app.inject({ method: 'POST', url: `/api/v1/executions/${execId}/start`, headers });
  return execId;
}

describe('autenticação e sessão', () => {
  it('registra organização e usuário, define cookie HttpOnly e responde /me', async () => {
    const { res, headers } = await register('ana@example.com');
    expect(res.statusCode).toBe(201);
    const cookie = res.cookies.find((c) => c.name === 'ca_session');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Strict');
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe('ana@example.com');
    expect(JSON.stringify(me.json())).not.toMatch(/passwordHash|mfaSecret/);
  });

  it('nega rotas privadas sem sessão', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/executions' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
  });

  it('exige o cabeçalho anti-CSRF em requisições que alteram dados', async () => {
    const { headers } = await register('ana@example.com');
    const { 'x-command-ai': _drop, ...withoutGuard } = headers;
    const res = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: withoutGuard, payload: { name: 'X', workspacePath: '/x' } });
    expect(res.statusCode).toBe(403);
  });

  it('responde igual para senha errada e usuário inexistente, e limita tentativas', async () => {
    await register('ana@example.com');
    const wrong = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: H, payload: { email: 'ana@example.com', password: 'errada-errada-1' } });
    const ghost = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: H, payload: { email: 'ghost@example.com', password: 'errada-errada-1' } });
    expect(wrong.statusCode).toBe(401);
    expect(ghost.statusCode).toBe(401);
    expect(wrong.json().detail).toBe(ghost.json().detail);

    let last = 0;
    for (let i = 0; i < 12; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: H, payload: { email: 'ana@example.com', password: 'errada-errada-1' } });
      last = r.statusCode;
    }
    expect(last).toBe(429);
  });

  it('exige o código MFA no login depois que o MFA é ativado', async () => {
    const { headers } = await register('ana@example.com');
    const enroll = await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/enroll', headers });
    const secret: string = enroll.json().secret;
    expect(secret).toBeTruthy();

    const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/activate', headers, payload: { code: '000000' } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/activate', headers, payload: { code: totpCode(secret) } });
    expect(ok.statusCode).toBe(200);

    const noCode = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: H, payload: { email: 'ana@example.com', password: PASSWORD } });
    expect(noCode.statusCode).toBe(401);
    expect(noCode.json().code).toBe('mfa_required');
    const withCode = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: H, payload: { email: 'ana@example.com', password: PASSWORD, totp: totpCode(secret, Date.now() + 30_000) } });
    expect(withCode.statusCode).toBe(200); // código da janela seguinte: o da ativação não pode ser reutilizado
  });

  it('gera segredos TOTP distintos', () => {
    expect(generateTotpSecret()).not.toBe(generateTotpSecret());
  });

  it('envia cabeçalhos de segurança', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });
});

describe('isolamento entre organizações', () => {
  it('não deixa a organização B ler, listar ou decidir recursos da A', async () => {
    const a = await register('a@example.com', 'Org A');
    const b = await register('b@example.com', 'Org B');
    const { agent, project } = await setupFlow(a.headers);
    const execId = await startHighRisk(a.headers, agent.id, project.id);

    const approvalsA = await app.inject({ method: 'GET', url: '/api/v1/approvals?status=pending', headers: a.headers });
    expect(approvalsA.json().items.length).toBe(1);
    const approvalId: string = approvalsA.json().items[0].id;

    expect((await app.inject({ method: 'GET', url: `/api/v1/executions/${execId}`, headers: b.headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/v1/executions/${execId}/events?format=json`, headers: b.headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/executions', headers: b.headers })).json().items).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/v1/approvals', headers: b.headers })).json().items).toEqual([]);
    const decide = await app.inject({ method: 'POST', url: `/api/v1/approvals/${approvalId}/decide`, headers: b.headers, payload: { decision: 'approved' } });
    expect(decide.statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/v1/executions/${execId}/cancel`, headers: b.headers })).statusCode).toBe(404);
  });

  it('rejeita criar execução com agente ou projeto de outra organização', async () => {
    const a = await register('a@example.com', 'Org A');
    const b = await register('b@example.com', 'Org B');
    const { agent, project } = await setupFlow(a.headers);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/executions',
      headers: b.headers,
      payload: { goal: 'Auditar o repositório', projectId: project.id, agentId: agent.id },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('fluxo completo com Runner', () => {
  it('planeja, edita, inicia, executa por um Runner e conclui; eventos têm seq e replay', async () => {
    const { headers } = await register('ana@example.com');
    const { agent, project } = await setupFlow(headers);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/executions',
      headers,
      payload: { goal: 'Auditar o repositório', projectId: project.id, agentId: agent.id },
    });
    const execId: string = created.json().execution.id;
    expect(created.json().tasks.length).toBe(3);

    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/v1/executions/${execId}/plan`,
      headers,
      payload: {
        tasks: [
          { id: 'um', title: 'Primeira', agentId: agent.id, dependsOn: [], risk: 'low' },
          { id: 'dois', title: 'Segunda', agentId: agent.id, dependsOn: ['um'], risk: 'low' },
        ],
      },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().tasks.length).toBe(2);

    const cyclic = await app.inject({
      method: 'PATCH',
      url: `/api/v1/executions/${execId}/plan`,
      headers,
      payload: {
        tasks: [
          { id: 'um', title: 'A', agentId: agent.id, dependsOn: ['dois'], risk: 'low' },
          { id: 'dois', title: 'B', agentId: agent.id, dependsOn: ['um'], risk: 'low' },
        ],
      },
    });
    expect(cyclic.statusCode).toBe(422);

    const runner = (await app.inject({ method: 'POST', url: '/api/v1/runners', headers, payload: { name: 'Notebook' } })).json();
    expect(runner.token).toMatch(/^car_/);
    const rHeaders = { authorization: `Bearer ${runner.token}`, 'content-type': 'application/json' };

    // Antes de iniciar não há trabalho.
    expect((await app.inject({ method: 'POST', url: '/api/v1/runner/claim', headers: rHeaders })).statusCode).toBe(204);

    await app.inject({ method: 'POST', url: `/api/v1/executions/${execId}/start`, headers });

    for (const title of ['Primeira', 'Segunda']) {
      const claim = await app.inject({ method: 'POST', url: '/api/v1/runner/claim', headers: rHeaders });
      expect(claim.statusCode).toBe(200);
      const job = claim.json().job;
      expect(verifyJob(job, SIGNING_KEY)).toBe(true);
      expect(job.payload.workspacePath).toBe('/work/repo');
      expect(job.payload.prompt).toContain(title);
      await app.inject({ method: 'POST', url: `/api/v1/runner/tasks/${encodeURIComponent(job.payload.taskId)}/log`, headers: rHeaders, payload: { line: 'trabalhando' } });
      const done = await app.inject({
        method: 'POST',
        url: `/api/v1/runner/tasks/${encodeURIComponent(job.payload.taskId)}/complete`,
        headers: rHeaders,
        payload: { output: 'ok', usage: { model: 'claude-sonnet-5-5', inputTokens: 100, outputTokens: 50 } },
      });
      expect(done.statusCode).toBe(200);
    }

    const detail = (await app.inject({ method: 'GET', url: `/api/v1/executions/${execId}`, headers })).json();
    expect(detail.execution.status).toBe('succeeded');
    expect(detail.execution.inputTokens).toBe(200);

    const all = (await app.inject({ method: 'GET', url: `/api/v1/executions/${execId}/events?format=json`, headers })).json().items;
    const seqs = all.map((e: { seq: number }) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
    const replay = (await app.inject({ method: 'GET', url: `/api/v1/executions/${execId}/events?format=json&after=${seqs[2]}`, headers })).json().items;
    expect(replay[0].seq).toBe(seqs[2] + 1);
    expect(replay.length).toBe(seqs.length - 3);
  });

  it('recusa um token de Runner revogado ou inventado', async () => {
    const fake = await app.inject({ method: 'POST', url: '/api/v1/runner/claim', headers: { authorization: 'Bearer car_inventado' } });
    expect(fake.statusCode).toBe(401);

    const { headers } = await register('ana@example.com');
    const runner = (await app.inject({ method: 'POST', url: '/api/v1/runners', headers, payload: { name: 'N' } })).json();
    await app.inject({ method: 'DELETE', url: `/api/v1/runners/${runner.runner.id}`, headers });
    const revoked = await app.inject({ method: 'POST', url: '/api/v1/runner/claim', headers: { authorization: `Bearer ${runner.token}` } });
    expect(revoked.statusCode).toBe(401);
  });

  it('lista templates de agente e registra auditoria da decisão de aprovação', async () => {
    const { headers } = await register('ana@example.com');
    const templates = await app.inject({ method: 'GET', url: '/api/v1/agent-templates', headers });
    expect(templates.json().items.length).toBeGreaterThan(0);

    const { agent, project } = await setupFlow(headers);
    const execId = await startHighRisk(headers, agent.id, project.id);
    const pending = (await app.inject({ method: 'GET', url: '/api/v1/approvals?status=pending', headers })).json().items;
    expect(pending.length).toBe(1);
    expect(pending[0].task.risk).toBe('high');
    expect(pending[0].project.name).toBe('Repo');
    expect(pending[0].agent.name).toBe('Auditor');

    const decided = await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/${pending[0].id}/decide`,
      headers,
      payload: { decision: 'rejected', reason: 'Fora da janela de deploy' },
    });
    expect(decided.statusCode).toBe(200);
    const again = await app.inject({ method: 'POST', url: `/api/v1/approvals/${pending[0].id}/decide`, headers, payload: { decision: 'approved' } });
    expect(again.statusCode).toBe(409);

    const audit = (await app.inject({ method: 'GET', url: '/api/v1/audit', headers })).json().items;
    expect(audit.some((a: { action: string }) => a.action === 'approval.rejected')).toBe(true);
    const detail = (await app.inject({ method: 'GET', url: `/api/v1/executions/${execId}`, headers })).json();
    expect(detail.execution.status).toBe('failed');
  });
});
