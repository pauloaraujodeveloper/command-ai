import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import {
  agentSchema,
  createExecutionSchema,
  decideApprovalSchema,
  loginSchema,
  mfaActivateSchema,
  projectSchema,
  providerSchema,
  registerSchema,
  runnerReportSchema,
  runnerUsageSchema,
  toolApprovalRequestSchema,
  updatePlanSchema,
  type Role,
} from '@command-ai/shared';
import { signJob } from '@command-ai/shared/signing';
import type { EventEnvelope } from '@command-ai/shared';
import {
  dummyHash,
  generateTotpSecret,
  hashPassword,
  newToken,
  otpauthUri,
  sha256,
  needsRehash,
  verifyPassword,
  verifyTotpStep,
} from './auth.ts';
import type { NeonVerifier } from './neon-auth.ts';
import { Orchestrator, OrchestratorError, type OrchestratorOptions } from './orchestrator.ts';
import { MemoryLimiter, type AttemptLimiter } from './rate-limit.ts';
import { AGENT_TEMPLATES, CAPABILITIES } from './providers.ts';
import { MemoryRepo, type Repo, type UnitContext, type UnitHandle } from './repo.ts';
import { createStore, type Store, type User } from './store.ts';

export interface AppOptions {
  jobSigningKey: string;
  /** Contador de falhas de login e MFA. Padrão: em memória do processo (cada instância conta sozinha). */
  attemptLimiter?: AttemptLimiter;
  /** Quanto tempo uma chave de idempotência vale (padrão 24 h). */
  idempotencyTtlMs?: number;
  /** Máximo de chaves guardadas por organização (padrão 500); as mais antigas saem primeiro. */
  idempotencyMaxKeys?: number;
  production: boolean;
  logger?: boolean;
  /** Destino dos logs (nível warn ou acima). Usado em testes para conferir que a API não registra erros inesperados. */
  loggerStream?: NodeJS.WritableStream;
  /**
   * Acesso aos dados. Padrão: em memória (testes e demonstração). Com `PgRepo`, o estado vive no PostgreSQL
   * e várias instâncias da API (e o Worker) compartilham o mesmo estado.
   */
  repo?: Repo;
  /** Ajustes do orquestrador (lease, espera entre tentativas, prazo). Só vale para o repositório em memória padrão. */
  orchestrator?: OrchestratorOptions;
  /** Verificador de JWT do Neon Auth. Sem ele, a rota /auth/neon/session fica desativada. */
  neonAuth?: NeonVerifier;
  /** Pasta do build do app web (apps/web/dist). Quando definida, a API serve o app na mesma origem. */
  webDist?: string;
  /** URL do Neon Auth, liberada em connect-src porque o navegador a chama direto. */
  neonAuthBaseUrl?: string;
  /**
   * Exige MFA de todas as contas. Quem ainda não ativou recebe uma sessão limitada (só configura o MFA);
   * quem já ativou nunca recebe sessão sem o código. Padrão: desligado; o servidor liga em produção.
   */
  requireMfa?: boolean;
}

/** CSP do app web servido pela API. Scripts só de 'self'; estilos inline são necessários para atributos style do React. */
function appCsp(neonAuthBaseUrl?: string): string {
  const connect = ["'self'"];
  if (neonAuthBaseUrl) connect.push(new URL(neonAuthBaseUrl).origin);
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    `connect-src ${connect.join(' ')}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

interface Auth {
  userId: string;
  organizationId: string;
  role: Role;
  /** Sessão ainda sem segundo fator (política requireMfa): só pode configurar o MFA. */
  limited: boolean;
}

const SESSION_COOKIE = 'ca_session';
/** Tamanho máximo do resultado de uma tarefa repassado às dependentes. */
const UPSTREAM_MAX = 8_000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const RUNNER_ONLINE_MS = 30_000;
const WRITE_ROLES: Role[] = ['owner', 'admin', 'developer', 'operator'];
const DECIDE_ROLES: Role[] = ['owner', 'admin', 'operator'];

const ERROR_STATUS: Record<string, number> = {
  invalid_plan: 422,
  not_found: 404,
  invalid_transition: 409,
  already_decided: 409,
  not_draft: 409,
  stale_attempt: 409,
  too_many_pending: 429,
};

export async function buildApp(opts: AppOptions) {
  const repo: Repo = opts.repo ?? new MemoryRepo({ orchestrator: opts.orchestrator });
  const app = Fastify({ logger: opts.loggerStream ? { level: 'warn', stream: opts.loggerStream } : (opts.logger ?? true), bodyLimit: 1_048_576 });

  /*
   * Cada requisição à API roda dentro de uma unidade de trabalho: o estado da organização é carregado (e, em escrita,
   * travado) antes do handler e confirmado depois. `store` e `orchestrator` abaixo apontam para a unidade da requisição
   * em curso; assim as rotas continuam síncronas e iguais em memória e no PostgreSQL.
   */
  const als = new AsyncLocalStorage<UnitContext>();
  const memory = repo instanceof MemoryRepo ? repo : undefined;
  const current = (): UnitContext => {
    const ctx = als.getStore() ?? (memory ? { store: memory.store, orchestrator: memory.orchestrator } : undefined);
    if (!ctx) throw new Error('Acesso ao estado fora de uma unidade de trabalho');
    return ctx;
  };
  const store = new Proxy({} as Store, { get: (_t, key) => (current().store as unknown as Record<string | symbol, unknown>)[key] });
  const orchestrator = new Proxy({} as Orchestrator, {
    get: (_t, key) => {
      const o = current().orchestrator as unknown as Record<string | symbol, unknown>;
      const v = o[key];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(o) : v;
    },
  });
  const units = new WeakMap<FastifyRequest, UnitHandle>();

  await app.register(cookie);

  /* ---------- JSON tolerante a corpo vazio ---------- */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body || (body as string).length === 0) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      const err = new Error('JSON inválido') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  /* ---------- erros no formato RFC 9457 ---------- */
  function problem(reply: FastifyReply, status: number, code: string, detail: string, extra: object = {}) {
    return reply
      .code(status)
      .header('content-type', 'application/problem+json')
      .send({ type: `https://commandai.dev/problems/${code}`, title: code, status, code, detail, ...extra });
  }

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof OrchestratorError) {
      return problem(reply, ERROR_STATUS[err.code] ?? 400, err.code, err.message);
    }
    if (err instanceof ZodError) {
      return problem(reply, 400, 'validation_error', 'Dados inválidos.', {
        errors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) req.log.error(err);
    return problem(reply, status, status === 500 ? 'internal_error' : 'bad_request', status === 500 ? 'Erro interno.' : err.message);
  });
  /* ---------- app web (mesma origem: cookie SameSite=Strict, SSE e PWA funcionam sem CORS) ---------- */
  if (opts.webDist) {
    await app.register(fastifyStatic, {
      root: opts.webDist,
      wildcard: false,
      cacheControl: false,
      setHeaders: (res, filePath) => {
        const immutable = /[\\/]assets[\\/]/.test(filePath);
        res.header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }
  app.setNotFoundHandler((req, reply) => {
    const isApi = req.url.startsWith('/api/');
    if (opts.webDist && !isApi && (req.method === 'GET' || req.method === 'HEAD')) {
      // Rotas do app (React Router) caem no index.html.
      return reply.header('cache-control', 'no-cache').type('text/html; charset=utf-8').sendFile('index.html');
    }
    return problem(reply, 404, 'not_found', 'Recurso não encontrado.');
  });

  /* ---------- cabeçalhos de segurança e proteção CSRF ---------- */
  const webCsp = appCsp(opts.neonAuthBaseUrl);
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    const strict = !opts.webDist || req.url.startsWith('/api/');
    reply.header('content-security-policy', strict ? "default-src 'none'; frame-ancestors 'none'" : webCsp);
    if (opts.production) reply.header('strict-transport-security', 'max-age=63072000; includeSubDomains');
  });

  app.addHook('onRequest', async (req, reply) => {
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const isRunnerApi = req.url.startsWith('/api/v1/runner/');
    // Requisição de navegador que muda dados precisa de cabeçalho personalizado
    // (um site de terceiros não consegue enviá-lo sem preflight CORS, que não autorizamos).
    if (mutating && !isRunnerApi && req.headers['x-command-ai'] !== '1') {
      return problem(reply, 403, 'csrf_blocked', 'Cabeçalho de proteção ausente.');
    }
  });

  /* ---------- unidade de trabalho por requisição ---------- */
  // Rotas que não dependem de organização conhecida de antemão (têm tratamento próprio) ou nem tocam dados.
  const NO_UNIT = new Set(['/api/v1/health', '/api/v1/auth/register', '/api/v1/auth/login', '/api/v1/auth/neon/session']);
  const lastTouch = new Map<string, number>();
  const touchDue = (key: string, everyMs: number) => {
    const now = Date.now();
    if (now - (lastTouch.get(key) ?? 0) < everyMs) return false;
    lastTouch.set(key, now);
    if (lastTouch.size > 5_000) lastTouch.clear();
    return true;
  };

  app.addHook('preHandler', (req, reply, done) => {
    const path = req.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/v1/') || NO_UNIT.has(path)) return done();

    void (async () => {
      const mode = req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'write';
      const header = req.headers.authorization ?? '';
      const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
      const raw = req.cookies[SESSION_COOKIE];
      let org: string | null = null;

      if (path.startsWith('/api/v1/runner/')) {
        const runner = bearer ? await repo.findRunnerByTokenHash(sha256(bearer)) : null;
        org = runner?.organizationId ?? null;
        // O Runner consulta a fila a cada poucos segundos: sem tarefa à espera, responde 204 sem carregar nem travar nada.
        if (runner && org && path === '/api/v1/runner/claim' && !(await repo.hasClaimable(org))) {
          if (touchDue(`runner:${runner.id}`, 10_000)) await repo.touchRunner(org, runner.id, new Date().toISOString());
          void reply.code(204).send();
          return 'sent' as const;
        }
      } else if (raw) {
        const hash = sha256(raw);
        const session = await repo.findSession(hash);
        org = session?.organizationId ?? null;
        // Leituras não gravam, então a validade da sessão é renovada à parte, no máximo uma vez por minuto.
        if (session && mode === 'read' && repo.kind === 'pg' && touchDue(`session:${hash}`, 60_000)) {
          const now = Date.now();
          void repo.touchSession(session.organizationId, hash, now, now + SESSION_TTL_MS).catch(() => undefined);
        }
      }

      if (!org) {
        // Sem sessão ou token válidos: o handler recebe um estado vazio e responde 401 pelo caminho normal.
        const empty = createStore();
        return { ctx: { store: empty, orchestrator: new Orchestrator(empty) } satisfies UnitContext, handle: null };
      }
      const handle = await repo.begin(org, mode);
      units.set(req, handle);
      return { ctx: { store: handle.store, orchestrator: handle.orchestrator }, handle };
    })().then(
      (out) => {
        if (out === 'sent' || out === undefined) return; // resposta já enviada (204 do claim)
        als.run(out.ctx, done);
      },
      (err) => done(err as Error),
    );
  });

  /* ---------- Idempotency-Key: criações repetidas (clique duplo, nova tentativa de rede) não duplicam ---------- */
  // Fica de fora o que devolve segredo (token de Runner): guardar a resposta seria guardar o segredo.
  const IDEMPOTENT_POSTS = new Set(['/api/v1/executions', '/api/v1/agents', '/api/v1/projects', '/api/v1/providers']);
  const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
  const idemTtl = opts.idempotencyTtlMs ?? 24 * 60 * 60 * 1000;
  const idemMax = opts.idempotencyMaxKeys ?? 500;
  const idemPending = new WeakMap<FastifyRequest, { id: string; fingerprint: string; organizationId: string }>();
  const canonical = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canonical(x)])) : v;

  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    const raw = req.headers['idempotency-key'];
    if (req.method !== 'POST' || !IDEMPOTENT_POSTS.has(path) || raw === undefined) return;
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (!key || !IDEMPOTENCY_KEY_RE.test(key)) {
      return problem(reply, 400, 'invalid_idempotency_key', 'Idempotency-Key deve ter de 8 a 128 caracteres (letras, números, _ . : -).');
    }
    const cookie = req.cookies[SESSION_COOKIE];
    const session = cookie ? store.sessions.get(sha256(cookie)) : undefined;
    if (!session || session.expiresAt < Date.now()) return; // sem sessão válida: o handler responde 401 pelo caminho normal
    const id = `${session.userId}:${key}`;
    const fingerprint = sha256(JSON.stringify([req.method, path, canonical(req.body ?? null)]));
    const found = store.idempotency.get(id);
    if (found && Date.now() - found.createdAt < idemTtl) {
      if (found.fingerprint !== fingerprint) {
        return problem(reply, 422, 'idempotency_key_reuse', 'Esta Idempotency-Key já foi usada com outra requisição.');
      }
      void reply.code(found.status).header('content-type', found.contentType).header('idempotent-replayed', 'true').send(found.body);
      return reply;
    }
    idemPending.set(req, { id, fingerprint, organizationId: session.organizationId });
  });

  // Guarda a resposta de sucesso na mesma unidade de trabalho que criou o recurso (grava junto ou não grava).
  app.addHook('onSend', async (req, reply, payload) => {
    const pending = idemPending.get(req);
    if (!pending) return payload;
    idemPending.delete(req);
    const handle = units.get(req);
    if (!handle || reply.statusCode < 200 || reply.statusCode >= 300 || typeof payload !== 'string' || payload.length > 64_000) return payload;
    const st = handle.store;
    const now = Date.now();
    st.idempotency.insert({
      id: pending.id,
      organizationId: pending.organizationId,
      fingerprint: pending.fingerprint,
      status: reply.statusCode,
      contentType: String(reply.getHeader('content-type') ?? 'application/json; charset=utf-8'),
      body: payload,
      createdAt: now,
    });
    // Poda: vencidas e, passando do limite, as mais antigas.
    const mine = st.idempotency.filter((r) => r.organizationId === pending.organizationId).sort((a, b) => a.createdAt - b.createdAt);
    const expired = mine.filter((r) => now - r.createdAt >= idemTtl);
    const live = mine.filter((r) => now - r.createdAt < idemTtl);
    for (const r of expired) st.idempotency.delete(r.id);
    for (const r of live.slice(0, Math.max(0, live.length - idemMax))) st.idempotency.delete(r.id);
    return payload;
  });

  // Confirma (ou desfaz) a unidade de trabalho antes de a resposta sair: o cliente só recebe sucesso se estiver gravado.
  app.addHook('onSend', async (req, reply, payload) => {
    const handle = units.get(req);
    if (!handle) return payload;
    units.delete(req);
    if (reply.statusCode >= 400) {
      await handle.rollback();
      return payload;
    }
    try {
      await handle.commit();
      return payload;
    } catch (err) {
      await handle.rollback().catch(() => undefined);
      req.log.error(err);
      reply.code(500).header('content-type', 'application/problem+json');
      return JSON.stringify({ type: 'https://commandai.dev/problems/internal_error', title: 'internal_error', status: 500, code: 'internal_error', detail: 'Não foi possível gravar a operação.' });
    }
  });

  // Cliente que desconectou no meio: nunca deixar a transação (e a trava da organização) abertas.
  app.addHook('onRequestAbort', async (req) => {
    const handle = units.get(req);
    if (handle) {
      units.delete(req);
      await handle.rollback();
    }
  });

  /* ---------- helpers ---------- */
  const parse = <S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> => schema.parse(data);

  /** `allowLimited`: rotas que uma sessão sem MFA pode usar (/me e a configuração do MFA). */
  function authOf(req: FastifyRequest, reply: FastifyReply, roles?: Role[], allowLimited = false): Auth | null {
    const raw = req.cookies[SESSION_COOKIE];
    const session = raw ? store.sessions.get(sha256(raw)) : undefined;
    const now = Date.now();
    if (!session || session.expiresAt < now) {
      if (session) store.sessions.delete(session.id);
      problem(reply, 401, 'unauthenticated', 'Entre para continuar.');
      return null;
    }
    const user = store.users.get(session.userId);
    if (!user) {
      problem(reply, 401, 'unauthenticated', 'Entre para continuar.');
      return null;
    }
    store.sessions.update(session.id, { lastSeenAt: now, expiresAt: now + SESSION_TTL_MS });
    const limited = session.limited === true;
    if (limited && !allowLimited) {
      problem(reply, 403, 'mfa_enrollment_required', 'Ative o MFA para continuar.');
      return null;
    }
    if (roles && !roles.includes(user.role)) {
      problem(reply, 403, 'forbidden', 'Seu papel não permite esta ação.');
      return null;
    }
    return { userId: user.id, organizationId: user.organizationId, role: user.role, limited };
  }

  /**
   * Cria a sessão no `st` informado e devolve o token (que só existe aqui; no banco fica o hash).
   * Chamado só depois de todas as verificações (senha, TOTP, JWT).
   * Com requireMfa, quem ainda não tem MFA ativo recebe sessão limitada: nada além de configurar o MFA.
   */
  function newSession(st: Store, user: { id: string; organizationId: string; mfaEnabled: boolean }): string {
    const token = newToken();
    const now = Date.now();
    const limited = Boolean(opts.requireMfa) && !user.mfaEnabled;
    st.sessions.insert({ id: sha256(token), userId: user.id, organizationId: user.organizationId, limited, expiresAt: now + SESSION_TTL_MS, lastSeenAt: now });
    return token;
  }

  function setSessionCookie(reply: FastifyReply, token: string) {
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: opts.production,
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    });
  }

  /**
   * Valida o código TOTP e consome o passo: o mesmo código (ou um mais antigo) nunca vale duas vezes.
   * Só grava o passo quando o código confere.
   */
  function acceptTotp(st: Store, userId: string, code: string): boolean {
    const user = st.users.get(userId);
    if (!user?.mfaSecret) return false;
    const step = verifyTotpStep(user.mfaSecret, code);
    if (step === null || (user.lastTotpStep !== undefined && step <= user.lastTotpStep)) return false;
    st.users.update(userId, { lastTotpStep: step });
    return true;
  }

  const publicUser = (u: NonNullable<ReturnType<Store['users']['get']>>) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    mfaEnabled: u.mfaEnabled,
    organizationId: u.organizationId,
  });

  function orgExecution(auth: Auth, id: string) {
    const exec = store.executions.get(id);
    return exec && exec.organizationId === auth.organizationId ? exec : undefined;
  }

  function executionView(id: string) {
    const exec = store.executions.get(id)!;
    const tasks = store.tasks.filter((t) => t.executionId === id).sort((a, b) => a.position - b.position);
    return { execution: exec, tasks };
  }

  /* ---------- limitador de tentativas de login ---------- */
  // Padrão: contador em memória do processo. O servidor passa um limitador compartilhado (Redis) para valer entre instâncias.
  const limiter: AttemptLimiter = opts.attemptLimiter ?? new MemoryLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
  const failKey = (req: FastifyRequest, email: string) => `${req.ip}|${email}`;
  const isLimited = (key: string) => limiter.isLimited(key);
  const registerFailure = (key: string) => limiter.registerFailure(key);
  const clearFailures = (key: string) => limiter.reset(key);

  const api = '/api/v1';

  app.get(`${api}/health`, async () => ({ status: 'ok', time: new Date().toISOString() }));

  /* ======================== autenticação ======================== */

  app.post(`${api}/auth/register`, async (req, reply) => {
    const body = parse(registerSchema, req.body);
    const taken = () => problem(reply, 409, 'email_in_use', 'Não foi possível criar a conta com estes dados.');
    if (await repo.findUserByEmail(body.email)) return taken();

    const passwordHash = await hashPassword(body.password); // fora da transação: é lento de propósito
    const orgId = randomUUID();
    let created: { user: User; token: string };
    try {
      created = await repo.uow(orgId, 'write', ({ store: st }) => {
        const org = st.organizations.insert({ id: orgId, name: body.orgName });
        const user = st.users.insert({
          id: randomUUID(),
          organizationId: org.id,
          name: body.name,
          email: body.email,
          role: 'owner',
          passwordHash,
          mfaSecret: null,
          mfaEnabled: false,
          createdAt: new Date().toISOString(),
        });
        st.audit({ organizationId: org.id, actor: user.id, action: 'user.registered', target: user.id });
        return { user, token: newSession(st, user) };
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return taken(); // e-mail repetido numa corrida entre duas requisições
      throw err;
    }
    setSessionCookie(reply, created.token);
    return reply.code(201).send({ user: publicUser(created.user) });
  });

  app.post(`${api}/auth/login`, async (req, reply) => {
    const body = parse(loginSchema, req.body);
    const key = failKey(req, body.email);
    if (await isLimited(key)) return problem(reply, 429, 'too_many_attempts', 'Muitas tentativas. Tente novamente em alguns minutos.');

    const found = await repo.findUserByEmail(body.email);
    const valid = await verifyPassword(body.password, found?.passwordHash ?? (await dummyHash()));
    if (!found || !valid) {
      await registerFailure(key);
      return problem(reply, 401, 'invalid_credentials', 'E-mail ou senha incorretos.');
    }
    // Migração silenciosa: scrypt (ou argon2id mais fraco que a política) vira argon2id com a senha que acabou de conferir.
    // O hash novo é calculado fora da transação (é lento de propósito) e só gravado se o login for concluído.
    const upgraded = needsRehash(found.passwordHash) ? await hashPassword(body.password) : null;

    const outcome = await repo.uow(found.organizationId, 'write', ({ store: st }) => {
      const user = st.users.get(found.id); // relê dentro da trava: o estado pode ter mudado
      if (!user) return { error: 'invalid_credentials' as const };
      if (user.mfaEnabled && user.mfaSecret) {
        if (!body.totp) return { error: 'mfa_required' as const };
        if (!acceptTotp(st, user.id, body.totp)) return { error: 'invalid_mfa' as const };
      }
      if (upgraded) st.users.update(user.id, { passwordHash: upgraded });
      const token = newSession(st, user);
      st.audit({ organizationId: user.organizationId, actor: user.id, action: 'user.login', target: user.id });
      return { user: st.users.get(user.id)!, token };
    });
    if ('error' in outcome) {
      if (outcome.error === 'mfa_required') return problem(reply, 401, 'mfa_required', 'Informe o código do aplicativo autenticador.');
      await registerFailure(key);
      if (outcome.error === 'invalid_mfa') return problem(reply, 401, 'invalid_mfa', 'Código inválido ou expirado.');
      return problem(reply, 401, 'invalid_credentials', 'E-mail ou senha incorretos.');
    }
    await clearFailures(key);
    setSessionCookie(reply, outcome.token);
    return { user: publicUser(outcome.user) };
  });

  /**
   * Ponte com o Neon Auth: o navegador entra no Neon Auth, obtém o JWT e troca por uma sessão HttpOnly daqui.
   * A identidade é a claim `sub`, nunca o e-mail: um e-mail igual ao de uma conta local não vincula nem assume a conta.
   * O Neon Auth gerenciado não oferece MFA; contas daqui com MFA ativo ainda precisam informar o TOTP.
   */
  app.post(`${api}/auth/neon/session`, async (req, reply) => {
    if (!opts.neonAuth) return problem(reply, 501, 'neon_auth_disabled', 'O Neon Auth não está configurado neste servidor.');
    const key = failKey(req, 'neon');
    if (await isLimited(key)) return problem(reply, 429, 'too_many_attempts', 'Muitas tentativas. Tente novamente em alguns minutos.');

    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const identity = token ? await opts.neonAuth(token) : null;
    if (!identity) {
      await registerFailure(key);
      return problem(reply, 401, 'invalid_neon_token', 'Token do Neon Auth inválido ou expirado.');
    }

    const existing = await repo.findUserByNeonSub(identity.sub);
    const conflict = () => problem(reply, 409, 'email_in_use', 'Já existe uma conta com este e-mail. Entre com a senha dela.');
    if (!existing && (await repo.findUserByEmail(identity.email))) return conflict();

    const totp = (req.body as { totp?: string } | undefined)?.totp;
    const orgId = existing?.organizationId ?? randomUUID();
    let outcome: { error: 'mfa_required' | 'invalid_mfa' } | { user: User; token: string };
    try {
      outcome = await repo.uow(orgId, 'write', ({ store: st }) => {
        let user = existing ? st.users.get(existing.id) : undefined;
        if (!user) {
          const org = st.organizations.insert({ id: orgId, name: `Organização de ${identity.name}` });
          user = st.users.insert({
            id: randomUUID(),
            neonAuthId: identity.sub,
            organizationId: org.id,
            name: identity.name,
            email: identity.email,
            role: 'owner',
            passwordHash: '', // sem senha local: o acesso é pelo Neon Auth
            mfaSecret: null,
            mfaEnabled: false,
            createdAt: new Date().toISOString(),
          });
          st.audit({ organizationId: org.id, actor: user.id, action: 'user.provisioned_neon_auth', target: user.id });
        }
        if (user.mfaEnabled && user.mfaSecret) {
          if (!totp) return { error: 'mfa_required' as const };
          if (!acceptTotp(st, user.id, totp)) return { error: 'invalid_mfa' as const };
        }
        const token = newSession(st, user);
        st.audit({ organizationId: user.organizationId, actor: user.id, action: 'user.login_neon_auth', target: user.id });
        return { user, token };
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return conflict();
      throw err;
    }
    if ('error' in outcome) {
      if (outcome.error === 'mfa_required') return problem(reply, 401, 'mfa_required', 'Informe o código do aplicativo autenticador.');
      await registerFailure(key);
      return problem(reply, 401, 'invalid_mfa', 'Código inválido ou expirado.');
    }
    await clearFailures(key);
    setSessionCookie(reply, outcome.token);
    return { user: publicUser(outcome.user) };
  });

  app.post(`${api}/auth/logout`, async (req, reply) => {
    const raw = req.cookies[SESSION_COOKIE];
    if (raw) store.sessions.delete(sha256(raw));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get(`${api}/me`, async (req, reply) => {
    const auth = authOf(req, reply, undefined, true);
    if (!auth) return reply;
    const user = store.users.get(auth.userId)!;
    const org = store.organizations.get(auth.organizationId)!;
    return { user: publicUser(user), organization: org, mfaEnrollmentRequired: auth.limited };
  });

  app.post(`${api}/auth/mfa/enroll`, async (req, reply) => {
    const auth = authOf(req, reply, undefined, true);
    if (!auth) return reply;
    const user = store.users.get(auth.userId)!;
    if (user.mfaEnabled) return problem(reply, 409, 'mfa_already_enabled', 'O MFA já está ativo.');
    const secret = generateTotpSecret();
    store.users.update(user.id, { mfaSecret: secret });
    return { secret, otpauthUri: otpauthUri(secret, user.email) };
  });

  app.post(`${api}/auth/mfa/activate`, async (req, reply) => {
    const auth = authOf(req, reply, undefined, true);
    if (!auth) return reply;
    const { code } = parse(mfaActivateSchema, req.body);
    const user = store.users.get(auth.userId)!;
    const key = `mfa-activate|${user.id}`;
    if (await isLimited(key)) return problem(reply, 429, 'too_many_attempts', 'Muitas tentativas. Tente novamente em alguns minutos.');
    if (!acceptTotp(store, user.id, code)) {
      await registerFailure(key);
      return problem(reply, 400, 'invalid_mfa', 'Código inválido ou expirado.');
    }
    await clearFailures(key);
    store.users.update(user.id, { mfaEnabled: true });
    // Todas as sessões desta pessoa deixam de ser limitadas: o segundo fator foi provado agora.
    for (const s of store.sessions.filter((x) => x.userId === user.id && x.limited === true)) store.sessions.update(s.id, { limited: false });
    store.audit({ organizationId: user.organizationId, actor: user.id, action: 'mfa.enabled', target: user.id });
    return { mfaEnabled: true };
  });

  /* ======================== cadastros ======================== */

  app.get(`${api}/providers`, async (req, reply) => {
    const auth = authOf(req, reply);
    if (!auth) return reply;
    const items = store.providers
      .filter((p) => p.organizationId === auth.organizationId)
      .map((p) => ({ ...p, capabilities: CAPABILITIES[p.kind] }));
    return { items };
  });

  app.post(`${api}/providers`, async (req, reply) => {
    const auth = authOf(req, reply, ['owner', 'admin']);
    if (!auth) return reply;
    const body = parse(providerSchema, req.body);
    const provider = store.providers.insert({
      id: randomUUID(),
      organizationId: auth.organizationId,
      kind: body.kind,
      name: body.name,
      apiKeyRef: body.apiKeyRef ?? null,
      defaultModel: body.defaultModel,
      createdAt: new Date().toISOString(),
    });
    store.audit({ organizationId: auth.organizationId, actor: auth.userId, action: 'provider.created', target: provider.id });
    return reply.code(201).send({ ...provider, capabilities: CAPABILITIES[provider.kind] });
  });

  app.post(`${api}/providers/:id/test`, async (req, reply) => {
    const auth = authOf(req, reply, WRITE_ROLES);
    if (!auth) return reply;
    const { id } = req.params as { id: string };
    const provider = store.providers.get(id);
    if (!provider || provider.organizationId !== auth.organizationId) return problem(reply, 404, 'not_found', 'Provedor não encontrado.');
    // A chave fica no Runner. O teste real de conectividade roda lá (etapa 2); aqui só declaramos o que o adaptador sabe fazer.
    return {
      ok: true,
      verified: provider.kind === 'simulated',
      capabilities: CAPABILITIES[provider.kind],
      note:
        provider.kind === 'simulated'
          ? 'Provedor simulado: não usa rede nem chave.'
          : `A chave (${provider.apiKeyRef ?? 'não informada'}) fica no Runner. A conectividade é verificada quando o Runner executa a primeira tarefa.`,
    };
  });

  app.get(`${api}/agent-templates`, async (req, reply) => {
    if (!authOf(req, reply)) return reply;
    return { items: AGENT_TEMPLATES };
  });

  app.get(`${api}/agents`, async (req, reply) => {
    const auth = authOf(req, reply);
    if (!auth) return reply;
    return { items: store.agents.filter((a) => a.organizationId === auth.organizationId) };
  });

  app.post(`${api}/agents`, async (req, reply) => {
    const auth = authOf(req, reply, WRITE_ROLES);
    if (!auth) return reply;
    const body = parse(agentSchema, req.body);
    const agent = store.agents.insert({ id: randomUUID(), organizationId: auth.organizationId, ...body });
    store.audit({ organizationId: auth.organizationId, actor: auth.userId, action: 'agent.created', target: agent.id });
    return reply.code(201).send(agent);
  });

  app.get(`${api}/projects`, async (req, reply) => {
    const auth = authOf(req, reply);
    if (!auth) return reply;
    return { items: store.projects.filter((p) => p.organizationId === auth.organizationId) };
  });

  app.post(`${api}/projects`, async (req, reply) => {
    const auth = authOf(req, reply, WRITE_ROLES);
    if (!auth) return reply;
    const body = parse(projectSchema, req.body);
    const project = store.projects.insert({ id: randomUUID(), organizationId: auth.organizationId, ...body });
    store.audit({ organizationId: auth.organizationId, actor: auth.userId, action: 'project.created', target: project.id });
    return reply.code(201).send(project);
  });

  /* ======================== execuções ======================== */

  app.get(`${api}/executions`, async (req, reply) => {
    const auth = authOf(req, reply);
    if (!auth) return reply;
    const items = store.executions
      .filter((e) => e.organizationId === auth.organizationId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((e) => {
        const tasks = store.tasks.filter((t) => t.executionId === e.id);
        return { ...e, progress: { done: tasks.filter((t) => t.status === 'done').length, total: tasks.length } };
      });
    return { items };
  });

  app.post(`${api}/executions`, async (req, reply) => {
    const auth = authOf(req, reply, WRITE_ROLES);
    if (!auth) return reply;
    const body = parse(createExecutionSchema, req.body);
    const agent = store.agents.get(body.agentId);
    const project = store.projects.get(body.projectId);
    if (!agent || agent.organizationId !== auth.organizationId) return problem(reply, 404, 'not_found', 'Agente não encontrado.');
    if (!project || project.organizationId !== auth.organizationId) return problem(reply, 404, 'not_found', 'Projeto não encontrado.');
    const exec = orchestrator.createDraft({
      organizationId: auth.organizationId,
      projectId: project.id,
      agentId: agent.id,
      goal: body.goal,
      budgetUsd: body.budgetUsd ?? agent.budgetUsd,
      createdBy: auth.userId,
    });
    return reply.code(201).send(executionView(exec.id));
  });

  app.get(`${api}/executions/:id`, async (req, reply) => {
    const auth = authOf(req, reply);
    if (!auth) return reply;
    const exec = orgExecution(auth, (req.params as { id: string }).id);
    if (!exec) return problem(reply, 404, 'not_found', 'Execução não encontrada.');
    const approvals = store.approvals.filter((a) => a.executionId === exec.id);
    return { ...executionView(exec.id), approvals };
  });

  app.patch(`${api}/executions/:id/plan`, async (req, reply) => {
    const auth = authOf(req, reply, WRITE_ROLES);
    if (!auth) return reply;
    const exec = orgExecution(auth, (req.params as { id: string }).id);
    if (!exec) return problem(reply, 404, 'not_found', 'Execução não encontrada.');
    const { tasks } = parse(updatePlanSchema, req.body);
    // Agentes do plano precisam pertencer à organização.
    for (const t of tasks) {
      const a = store.agents.get(t.agentId);
      if (!a || a.organizationId !== auth.organizationId) return problem(reply, 404, 'not_found', `Agente não encontrado: ${t.agentId}`);
    }
    orchestrator.replacePlan(exec.id, tasks);
    return executionView(exec.id);
  });

  app.post(`${api}/executions/:id/start`, async (req, reply) => {
    const auth = authOf(req, reply, WRITE_ROLES);
    if (!auth) return reply;
    const exec = orgExecution(auth, (req.params as { id: string }).id);
    if (!exec) return problem(reply, 404, 'not_found', 'Execução não encontrada.');
    orchestrator.startExecution(exec.id);
    store.audit({ organizationId: auth.organizationId, actor: auth.userId, action: 'execution.started', target: exec.id });
    return executionView(exec.id);
  });

  app.post(`${api}/executions/:id/cancel`, async (req, reply) => {
    const auth = authOf(req, reply, WRITE_ROLES);
    if (!auth) return reply;
    const exec = orgExecution(auth, (req.params as { id: string }).id);
    if (!exec) return problem(reply, 404, 'not_found', 'Execução não encontrada.');
    orchestrator.cancelExecution(exec.id, auth.userId);
    return executionView(exec.id);
  });

  /** Eventos: JSON (?format=json) ou SSE com replay a partir do último seq recebido. */
  app.get(`${api}/executions/:id/events`, async (req, reply) => {
    const auth = authOf(req, reply);
    if (!auth) return reply;
    const exec = orgExecution(auth, (req.params as { id: string }).id);
    if (!exec) return problem(reply, 404, 'not_found', 'Execução não encontrada.');
    const query = req.query as { after?: string; format?: string };
    const lastEventId = req.headers['last-event-id'];
    // Na reconexão o navegador reenvia Last-Event-ID; ele tem prioridade sobre o ?after= inicial.
    const after = Number(typeof lastEventId === 'string' && lastEventId ? lastEventId : (query.after ?? 0)) || 0;

    const orgId = auth.organizationId;
    if (query.format === 'json') return { items: await repo.eventsAfter(orgId, exec.id, after) };

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    });
    let sent = after;
    const write = (e: { seq: number; type: string }) => {
      if (e.seq <= sent) return; // nunca reenvia nem desordena
      sent = e.seq;
      res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    // Assina antes de reler o passado: o que chegar no meio fica guardado e entra depois, sem buraco (o seq elimina repetição).
    const buffered: EventEnvelope[] = [];
    let replaying = true;
    const unsubscribe = repo.bus.subscribe(exec.id, (e) => (replaying ? buffered.push(e) : write(e)));
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    // Rede de segurança: se o canal ao vivo (Redis) falhar, o banco ainda entrega o que faltou a cada 10 s.
    const catchUp = setInterval(() => {
      if (replaying) return;
      void repo.eventsAfter(orgId, exec.id, sent).then((list) => list.forEach(write), () => undefined);
    }, 10_000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      clearInterval(catchUp);
      unsubscribe();
    });
    try {
      for (const e of await repo.eventsAfter(orgId, exec.id, after)) write(e);
      for (const e of buffered.sort((a, b) => a.seq - b.seq)) write(e);
    } catch (err) {
      req.log.error(err);
      res.end();
      return;
    } finally {
      replaying = false;
    }
  });

  /* ======================== aprovações ======================== */

  function approvalView(a: ReturnType<Store['approvals']['all']>[number]) {
    const task = store.tasks.get(a.taskId);
    const exec = store.executions.get(a.executionId);
    return {
      ...a,
      task: task && { id: task.id, title: task.title, risk: task.risk },
      goal: exec?.goal,
      agent: task && (() => {
        const ag = store.agents.get(task.agentId);
        return ag && { id: ag.id, name: ag.name, model: ag.model };
      })(),
      project: exec && (() => {
        const p = store.projects.get(exec.projectId);
        return p && { id: p.id, name: p.name, workspacePath: p.workspacePath };
      })(),
    };
  }

  app.get(`${api}/approvals`, async (req, reply) => {
    const auth = authOf(req, reply);
    if (!auth) return reply;
    const status = (req.query as { status?: string }).status;
    const items = store.approvals
      .filter((a) => a.organizationId === auth.organizationId && (!status || a.status === status))
      .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1))
      .map(approvalView);
    return { items };
  });

  app.post(`${api}/approvals/:id/decide`, async (req, reply) => {
    const auth = authOf(req, reply, DECIDE_ROLES);
    if (!auth) return reply;
    const approval = store.approvals.get((req.params as { id: string }).id);
    if (!approval || approval.organizationId !== auth.organizationId) return problem(reply, 404, 'not_found', 'Aprovação não encontrada.');
    const body = parse(decideApprovalSchema, req.body);
    orchestrator.decideApproval(approval.id, body.decision, auth.userId, body.reason);
    return approvalView(store.approvals.get(approval.id)!);
  });

  /* ======================== auditoria e painel ======================== */

  app.get(`${api}/audit`, async (req, reply) => {
    const auth = authOf(req, reply, ['owner', 'admin', 'operator']);
    if (!auth) return reply;
    return { items: await repo.auditList(auth.organizationId, 200) };
  });

  app.get(`${api}/dashboard`, async (req, reply) => {
    const auth = authOf(req, reply);
    if (!auth) return reply;
    const org = auth.organizationId;
    const attention: Array<{ kind: string; title: string; detail: string; to: string }> = [];

    for (const a of store.approvals.filter((x) => x.organizationId === org && x.status === 'pending')) {
      const v = approvalView(a);
      if (a.kind === 'tool' && a.tool) {
        attention.push({ kind: 'approval', title: `Aprovar ferramenta ${a.tool.name}: ${a.tool.summary.slice(0, 60)}`, detail: `Risco ${a.tool.risk} · ${v.agent?.name ?? ''}`, to: '/aprovacoes' });
      } else {
        attention.push({ kind: 'approval', title: `Aprovar: ${v.task?.title ?? 'tarefa'}`, detail: `Risco ${v.task?.risk} · ${v.agent?.name ?? ''}`, to: '/aprovacoes' });
      }
    }
    const execs = store.executions.filter((e) => e.organizationId === org);
    for (const e of execs.filter((x) => x.status === 'failed').slice(-3)) {
      attention.push({ kind: 'failure', title: `Falhou: ${e.goal.slice(0, 70)}`, detail: `Motivo: ${e.failureReason ?? 'desconhecido'}`, to: `/execucoes/${e.id}` });
    }
    for (const e of execs.filter((x) => x.status === 'running' && x.costUsd >= x.budgetUsd * 0.8)) {
      attention.push({ kind: 'budget', title: `Orçamento perto do limite: ${e.goal.slice(0, 50)}`, detail: `US$ ${e.costUsd.toFixed(2)} de US$ ${e.budgetUsd.toFixed(2)}`, to: `/execucoes/${e.id}` });
    }
    const runners = store.runners.filter((r) => r.organizationId === org && !r.revoked);
    const online = runners.filter((r) => r.lastSeenAt && Date.now() - Date.parse(r.lastSeenAt) < RUNNER_ONLINE_MS);
    if (runners.length === 0 || online.length === 0) {
      attention.push({
        kind: 'runner_offline',
        title: runners.length === 0 ? 'Nenhum Runner registrado' : 'Runner offline',
        detail: 'Sem Runner conectado, as tarefas ficam pausadas.',
        to: '/integracoes',
      });
    }

    const day = Date.now() - 24 * 3600 * 1000;
    const recent = execs.filter((e) => Date.parse(e.createdAt) >= day);
    return {
      attention,
      numbers: {
        running: execs.filter((e) => e.status === 'running' || e.status === 'waiting_approval').length,
        succeeded24h: recent.filter((e) => e.status === 'succeeded').length,
        failed24h: recent.filter((e) => e.status === 'failed').length,
        costUsd24h: recent.reduce((s, e) => s + e.costUsd, 0),
      },
      recent: [...execs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 5),
    };
  });

  /* ======================== Runners (gestão pelo painel) ======================== */

  app.get(`${api}/runners`, async (req, reply) => {
    const auth = authOf(req, reply);
    if (!auth) return reply;
    const items = store.runners
      .filter((r) => r.organizationId === auth.organizationId)
      .map(({ tokenHash: _t, ...r }) => ({ ...r, online: !r.revoked && !!r.lastSeenAt && Date.now() - Date.parse(r.lastSeenAt) < RUNNER_ONLINE_MS }));
    return { items };
  });

  app.post(`${api}/runners`, async (req, reply) => {
    const auth = authOf(req, reply, ['owner', 'admin']);
    if (!auth) return reply;
    const name = String((req.body as { name?: string })?.name ?? '').trim().slice(0, 80);
    if (!name) return problem(reply, 400, 'validation_error', 'Informe um nome para o Runner.');
    const token = newToken('car_');
    const runner = store.runners.insert({
      id: randomUUID(),
      organizationId: auth.organizationId,
      name,
      tokenHash: sha256(token),
      createdAt: new Date().toISOString(),
      revoked: false,
    });
    store.audit({ organizationId: auth.organizationId, actor: auth.userId, action: 'runner.created', target: runner.id });
    // O token é mostrado uma única vez.
    return reply.code(201).send({ runner: { id: runner.id, name: runner.name }, token });
  });

  app.delete(`${api}/runners/:id`, async (req, reply) => {
    const auth = authOf(req, reply, ['owner', 'admin']);
    if (!auth) return reply;
    const runner = store.runners.get((req.params as { id: string }).id);
    if (!runner || runner.organizationId !== auth.organizationId) return problem(reply, 404, 'not_found', 'Runner não encontrado.');
    store.runners.update(runner.id, { revoked: true });
    store.audit({ organizationId: auth.organizationId, actor: auth.userId, action: 'runner.revoked', target: runner.id });
    return { ok: true };
  });

  /* ======================== API do Runner (token Bearer) ======================== */

  function runnerOf(req: FastifyRequest, reply: FastifyReply) {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const hash = token ? sha256(token) : '';
    const runner = hash ? store.runners.filter((r) => r.tokenHash === hash && !r.revoked)[0] : undefined;
    if (!runner) {
      problem(reply, 401, 'unauthenticated', 'Token do Runner inválido ou revogado.');
      return null;
    }
    store.runners.update(runner.id, { lastSeenAt: new Date().toISOString() });
    return runner;
  }

  function runnerTask(req: FastifyRequest, reply: FastifyReply, runnerId: string, orgId: string) {
    const task = store.tasks.get((req.params as { id: string }).id);
    if (!task || task.organizationId !== orgId || task.runnerId !== runnerId) {
      problem(reply, 404, 'not_found', 'Tarefa não encontrada para este Runner.');
      return null;
    }
    return task;
  }

  app.post(`${api}/runner/claim`, async (req, reply) => {
    const runner = runnerOf(req, reply);
    if (!runner) return reply;
    const task = orchestrator.claimTask(runner.organizationId, runner.id);
    if (!task) return reply.code(204).send();
    const exec = store.executions.get(task.executionId)!;
    const project = store.projects.get(exec.projectId)!;
    const agent = store.agents.get(task.agentId)!;
    // Resultado das tarefas de que esta depende (só as diretas, na ordem do plano). É dado de outro agente: o Runner o trata como não confiável.
    const upstream = task.dependsOn
      .map((id) => store.tasks.get(id))
      .filter((t): t is NonNullable<typeof t> => !!t && t.executionId === task.executionId && t.status === 'done')
      .map((t) => {
        const out = t.output ?? '';
        return {
          taskId: t.id.slice(t.executionId.length + 1),
          title: t.title,
          output: out.length > UPSTREAM_MAX ? `${out.slice(0, UPSTREAM_MAX)}\n[resultado cortado: ${out.length - UPSTREAM_MAX} caracteres omitidos]` : out,
          ...(t.workspaceCommit ? { commit: t.workspaceCommit } : {}),
        };
      });
    const job = signJob(
      {
        taskId: task.id,
        upstream,
        executionId: exec.id,
        workspacePath: project.workspacePath,
        prompt: `${task.title}\n\nObjetivo geral: ${exec.goal}`,
        model: agent.model,
        instructions: agent.instructions,
        attempt: task.attempts,
        // Três batidas por lease: uma perdida de rede não derruba a tarefa.
        heartbeatMs: Math.max(1_000, Math.floor(orchestrator.leaseMs / 3)),
      },
      opts.jobSigningKey,
    );
    return { job };
  });

  app.post(`${api}/runner/tasks/:id/heartbeat`, async (req, reply) => {
    const runner = runnerOf(req, reply);
    if (!runner) return reply;
    const task = runnerTask(req, reply, runner.id, runner.organizationId);
    if (!task) return reply;
    // `cancel: true` é como o cancelamento da execução chega ao Runner.
    return orchestrator.heartbeat(task.id, runner.id);
  });

  /** Uso de cada interação com o modelo, enviado enquanto a tarefa roda. `cancel: true` manda o Runner parar. */
  app.post(`${api}/runner/tasks/:id/usage`, async (req, reply) => {
    const runner = runnerOf(req, reply);
    if (!runner) return reply;
    const task = runnerTask(req, reply, runner.id, runner.organizationId);
    if (!task) return reply;
    const body = parse(runnerUsageSchema, req.body);
    const out = orchestrator.addTaskUsage(task.id, body.usage, { turn: body.turn, attempt: body.attempt });
    return { ok: true, ...out };
  });

  /** O agente pede aprovação humana para usar uma ferramenta de risco. */
  app.post(`${api}/runner/tasks/:id/approvals`, async (req, reply) => {
    const runner = runnerOf(req, reply);
    if (!runner) return reply;
    const task = runnerTask(req, reply, runner.id, runner.organizationId);
    if (!task) return reply;
    const body = parse(toolApprovalRequestSchema, req.body);
    const approval = orchestrator.requestToolApproval(task.id, body, { attempt: body.attempt });
    return reply.code(201).send({ approvalId: approval.id });
  });

  app.get(`${api}/runner/tasks/:id/approvals/:approvalId`, async (req, reply) => {
    const runner = runnerOf(req, reply);
    if (!runner) return reply;
    const task = runnerTask(req, reply, runner.id, runner.organizationId);
    if (!task) return reply;
    const status = orchestrator.toolApprovalStatus(task.id, (req.params as { approvalId: string }).approvalId);
    if (!status) return problem(reply, 404, 'not_found', 'Pedido de aprovação não encontrado.');
    return status;
  });

  app.post(`${api}/runner/tasks/:id/log`, async (req, reply) => {
    const runner = runnerOf(req, reply);
    if (!runner) return reply;
    const task = runnerTask(req, reply, runner.id, runner.organizationId);
    if (!task) return reply;
    const { line } = parse(runnerReportSchema, req.body);
    if (line) orchestrator.appendLog(task.id, line);
    return { ok: true };
  });

  app.post(`${api}/runner/tasks/:id/complete`, async (req, reply) => {
    const runner = runnerOf(req, reply);
    if (!runner) return reply;
    const task = runnerTask(req, reply, runner.id, runner.organizationId);
    if (!task) return reply;
    const body = parse(runnerReportSchema, req.body);
    if (body.output === undefined || !body.usage) return problem(reply, 400, 'validation_error', 'Informe output e usage.');
    // Idempotente: repetição, tentativa antiga ou tarefa já cancelada voltam 200 com applied=false, sem efeito.
    const outcome = orchestrator.completeTask(task.id, { output: body.output, usage: body.usage, workspaceCommit: body.workspaceCommit }, { attempt: body.attempt });
    return { ok: true, applied: outcome === 'applied' };
  });

  app.post(`${api}/runner/tasks/:id/fail`, async (req, reply) => {
    const runner = runnerOf(req, reply);
    if (!runner) return reply;
    const task = runnerTask(req, reply, runner.id, runner.organizationId);
    if (!task) return reply;
    const body = parse(runnerReportSchema, req.body);
    const outcome = orchestrator.failTask(task.id, body.reason ?? 'falha_desconhecida', { attempt: body.attempt });
    return { ok: true, applied: outcome === 'applied' };
  });

  app.addHook('onClose', async () => {
    await repo.close();
  });

  return { app: app as FastifyInstance, store, orchestrator, repo };
}
