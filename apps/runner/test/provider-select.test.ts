import { describe, expect, it } from 'vitest';
import { AnthropicModelClient } from '../src/agent/anthropic-client.ts';
import { OpenAiCompatModelClient } from '../src/agent/openai-client.ts';
import { createModelFor, providerCheck } from '../src/agent/providers.ts';
import type { JobPayload } from '../src/runner.ts';

const job = (provider: JobPayload['provider'], model = 'm1'): JobPayload => ({ taskId: 't', executionId: 'e', workspacePath: '/w', prompt: 'p', model, provider });

describe('escolha do provedor pelo Runner', () => {
  it('cada tipo usa o cliente certo, com a chave do próprio ambiente do Runner', () => {
    const env = { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', DEEPSEEK_API_KEY: 'd' };
    expect(createModelFor(job('anthropic', 'claude-sonnet-5-5'), { env })).toBeInstanceOf(AnthropicModelClient);
    expect(createModelFor(job('openai', 'gpt-x'), { env })).toBeInstanceOf(OpenAiCompatModelClient);
    expect(createModelFor(job('deepseek', 'deepseek-chat'), { env })).toBeInstanceOf(OpenAiCompatModelClient);
    expect(createModelFor(job('ollama', 'llama3'), { env: {} })).toBeInstanceOf(OpenAiCompatModelClient); // local: sem chave
    expect(createModelFor(job('openai', 'gpt-x'), { env }).model).toBe('gpt-x');
  });

  it('chave ausente: erro que diz qual variável definir (sem inventar nada)', () => {
    expect(() => createModelFor(job('openai'), { env: {} })).toThrow(/OPENAI_API_KEY/);
    expect(() => createModelFor(job('deepseek'), { env: {} })).toThrow(/DEEPSEEK_API_KEY/);
    expect(() => createModelFor(job('anthropic'), { env: {} })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('provedor ausente no trabalho assume anthropic (trabalhos antigos); desconhecido ou simulado é recusado', () => {
    expect(createModelFor(job(undefined, 'claude-sonnet-5-5'), { env: { ANTHROPIC_API_KEY: 'a' } })).toBeInstanceOf(AnthropicModelClient);
    expect(() => createModelFor(job('simulated' as never), { env: { ANTHROPIC_API_KEY: 'a' } })).toThrow(/simulated|não suportado/i);
    expect(() => createModelFor(job('coisa' as never), { env: {} })).toThrow(/não suportado/i);
  });

  it('o servidor NÃO escolhe nome de variável nem endereço: nada vindo do trabalho entra na leitura de segredos', () => {
    const j = { ...job('openai'), provider: 'openai', apiKeyRef: 'DATABASE_URL', baseURL: 'https://evil.test' } as unknown as JobPayload;
    const env = { OPENAI_API_KEY: 'o', DATABASE_URL: 'postgres://segredo' };
    const c = createModelFor(j, { env }) as unknown as { o: { baseURL: string; apiKey: string } };
    expect(c.o.apiKey).toBe('o');
    expect(c.o.baseURL).toBe('https://api.openai.com/v1');
  });

  it('endereços padrão e substituição por variável do Runner', () => {
    const base = (p: JobPayload['provider'], env: Record<string, string>) => (createModelFor(job(p), { env: { OPENAI_API_KEY: 'o', DEEPSEEK_API_KEY: 'd', ...env } }) as unknown as { o: { baseURL: string } }).o.baseURL;
    expect(base('deepseek', {})).toBe('https://api.deepseek.com');
    expect(base('ollama', {})).toBe('http://127.0.0.1:11434/v1');
    expect(base('openai', { OPENAI_BASE_URL: 'http://127.0.0.1:8000/v1' })).toBe('http://127.0.0.1:8000/v1');
    expect(base('ollama', { OLLAMA_BASE_URL: 'http://192.168.0.5:11434/v1' })).toBe('http://192.168.0.5:11434/v1');
  });

  it('URL base com esquema estranho é recusada (nada de file:, javascript:)', () => {
    expect(() => createModelFor(job('openai'), { env: { OPENAI_API_KEY: 'o', OPENAI_BASE_URL: 'file:///etc/passwd' } })).toThrow(/URL/i);
    expect(() => createModelFor(job('ollama'), { env: { OLLAMA_BASE_URL: 'não é url' } })).toThrow(/URL/i);
  });

  it('providerCheck resume o que está configurado, sem mostrar chave', () => {
    const lines = providerCheck({ ANTHROPIC_API_KEY: 'sk-ant-segredo', OPENAI_API_KEY: '' });
    const text = lines.join('\n');
    expect(text).toMatch(/anthropic.*configurad/i);
    expect(text).toMatch(/openai.*não configurad/i);
    expect(text).toMatch(/ollama/i);
    expect(text).not.toContain('segredo');
  });
});
