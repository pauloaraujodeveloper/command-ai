import { describe, expect, it } from 'vitest';
import { canTransitionTask, costFor, PRICING } from '../src/index.ts';
import { signJob, verifyJob } from '../src/signing.ts';

describe('task state machine', () => {
  it('allows pending -> queued and queued -> running', () => {
    expect(canTransitionTask('pending', 'queued')).toBe(true);
    expect(canTransitionTask('queued', 'running')).toBe(true);
  });

  it('forbids skipping states, such as pending -> done', () => {
    expect(canTransitionTask('pending', 'done')).toBe(false);
  });

  it('keeps done and cancelled as terminal states', () => {
    expect(canTransitionTask('done', 'queued')).toBe(false);
    expect(canTransitionTask('cancelled', 'queued')).toBe(false);
  });

  it('allows a retry from running back to queued', () => {
    expect(canTransitionTask('running', 'queued')).toBe(true);
  });
});

describe('costFor', () => {
  it('computes cost in USD from input and output tokens', () => {
    const price = PRICING['claude-sonnet-5-5'];
    expect(price).toBeDefined();
    const cost = costFor('claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo((price?.inputPerMTok ?? 0) + (price?.outputPerMTok ?? 0), 6);
  });

  it('returns null for models without a configured price, never a silent estimate', () => {
    expect(costFor('unknown-model', { inputTokens: 10, outputTokens: 10 })).toBeNull();
  });

  it('usa os preços publicados da Anthropic para os modelos atuais (tabela de 2026-11-03)', () => {
    expect(costFor('claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(4 + 20, 6);
    expect(costFor('claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(2 + 10, 6);
    expect(costFor('claude-haiku-5-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(0.1 + 0.5, 6);
    expect(costFor('claude-fable-5-2', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(8 + 40, 6);
  });

  it('cobra leitura e escrita de cache pelos preços do modelo', () => {
    // Opus 5.5: leitura de cache a US$ 0,20/MTok e escrita a 1,25x a entrada (US$ 5).
    expect(costFor('claude-opus-5-5', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBeCloseTo(0.2, 6);
    expect(costFor('claude-opus-5-5', { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 })).toBeCloseTo(5, 6);
    // Sonnet 5.5: leitura a US$ 0,10.
    expect(costFor('claude-sonnet-5-5', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBeCloseTo(0.1, 6);
  });

  it('sem preço de cache conhecido, cobra o cache como entrada normal (nunca subestima)', () => {
    // Haiku 5.5 não tem preço de leitura de cache na tabela: vale o preço de entrada.
    expect(costFor('claude-haiku-5-5', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBeCloseTo(0.1, 6);
    expect(costFor('modelo-desconhecido', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 5 })).toBeNull();
  });

  it('o custo sem tokens de cache continua igual ao de antes', () => {
    expect(costFor('claude-opus-5-5', { inputTokens: 500_000, outputTokens: 100_000 })).toBeCloseTo(2 + 2, 6);
  });
});

describe('signed jobs', () => {
  const key = 'test-key-with-enough-length-123';
  const payload = { taskId: 't1', workspacePath: '/work/repo', prompt: 'auditar' };

  it('verifies a job signed with the same key', () => {
    const job = signJob(payload, key);
    expect(verifyJob(job, key)).toBe(true);
  });

  it('rejects a job whose payload was tampered with', () => {
    const job = signJob(payload, key);
    const tampered = { ...job, payload: { ...job.payload, workspacePath: '/etc' } };
    expect(verifyJob(tampered, key)).toBe(false);
  });

  it('rejects a job signed with a different key', () => {
    const job = signJob(payload, 'another-key-with-enough-length-999');
    expect(verifyJob(job, key)).toBe(false);
  });

  it('does not depend on key order in the payload', () => {
    const job = signJob({ a: 1, b: 2 }, key);
    expect(verifyJob({ payload: { b: 2, a: 1 }, signature: job.signature }, key)).toBe(true);
  });
});
