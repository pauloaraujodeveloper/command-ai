import { describe, expect, it } from 'vitest';
import { agentSchema } from '../src/index.ts';
import { softwareTeam } from '../src/team.ts';

describe('time de software padrão', () => {
  const team = softwareTeam({ providerKind: 'simulated', model: 'demo', budgetUsd: 5 });

  it('orquestrador + front-end, back-end, banco de dados e infraestrutura', () => {
    expect(team.orchestrator.kind).toBe('orchestrator');
    expect(team.specialists.map((s) => s.domain)).toEqual(['frontend', 'backend', 'database', 'infra']);
    expect(team.specialists.every((s) => s.kind === 'specialist')).toBe(true);
  });

  it('todas as definições passam no esquema de criação de agente', () => {
    for (const a of [team.orchestrator, ...team.specialists]) expect(() => agentSchema.parse(a)).not.toThrow();
  });

  it('usa o provedor, o modelo e o orçamento pedidos', () => {
    const t = softwareTeam({ providerKind: 'claude_code', model: 'sonnet', budgetUsd: 2 });
    for (const a of [t.orchestrator, ...t.specialists]) expect([a.providerKind, a.model, a.budgetUsd]).toEqual(['claude_code', 'sonnet', 2]);
  });

  it('cada especialista tem responsabilidades, escopo de escrita próprio e só depende de domínios que existem', () => {
    const domains = new Set(team.specialists.map((s) => s.domain));
    for (const s of team.specialists) {
      expect(s.responsibilities!.length).toBeGreaterThan(40);
      expect(s.writeScopes!.length).toBeGreaterThan(0);
      for (const d of s.dependsOnDomains) expect(domains.has(d)).toBe(true);
      expect(s.dependsOnDomains).not.toContain(s.domain);
    }
  });

  it('dependências do exemplo: front depende do back; back depende do banco; banco e infra não dependem de ninguém', () => {
    const dep = Object.fromEntries(team.specialists.map((s) => [s.domain, s.dependsOnDomains]));
    expect(dep).toEqual({ frontend: ['backend'], backend: ['database'], database: [], infra: [] });
  });

  it('os escopos não se sobrepõem em pastas óbvias (front não escreve no back e vice-versa)', () => {
    const scopes = Object.fromEntries(team.specialists.map((s) => [s.domain, s.writeScopes!.join(' ')]));
    expect(scopes.frontend).not.toMatch(/api|server|migrations/);
    expect(scopes.backend).not.toMatch(/web|frontend|migrations/);
  });

  it('o orquestrador não escreve em arquivos (planeja, delega e consolida)', () => {
    expect(team.orchestrator.writeScopes).toEqual([]);
  });
});
