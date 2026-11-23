import type { JobPayload } from '../runner.ts';
import { AnthropicModelClient } from './anthropic-client.ts';
import { OpenAiCompatModelClient } from './openai-client.ts';
import type { ModelClient } from './types.ts';

type Env = Record<string, string | undefined>;

interface ProviderDef {
  kind: 'anthropic' | 'openai' | 'deepseek' | 'ollama';
  /** Variável do ambiente do Runner com a chave. Fixa no Runner: o servidor nunca escolhe qual variável ler. */
  keyEnv: string | null;
  baseEnv?: string;
  defaultBase?: string;
}

const PROVIDERS: Record<string, ProviderDef> = {
  anthropic: { kind: 'anthropic', keyEnv: 'ANTHROPIC_API_KEY' },
  openai: { kind: 'openai', keyEnv: 'OPENAI_API_KEY', baseEnv: 'OPENAI_BASE_URL', defaultBase: 'https://api.openai.com/v1' },
  deepseek: { kind: 'deepseek', keyEnv: 'DEEPSEEK_API_KEY', baseEnv: 'DEEPSEEK_BASE_URL', defaultBase: 'https://api.deepseek.com' },
  ollama: { kind: 'ollama', keyEnv: null, baseEnv: 'OLLAMA_BASE_URL', defaultBase: 'http://127.0.0.1:11434/v1' },
};

function checkedUrl(raw: string, varName: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${varName} não é uma URL válida`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`${varName} precisa ser uma URL http ou https`);
  return raw;
}

/**
 * Cria o cliente de modelo do provedor do agente. Chaves e endereços vêm só do ambiente do Runner:
 * nada do que o servidor manda no trabalho (nem nome de variável, nem URL) entra na leitura de segredos.
 */
export function createModelFor(job: JobPayload, opts: { env?: Env } = {}): ModelClient {
  const env = opts.env ?? process.env;
  const kind = job.provider ?? 'anthropic'; // trabalhos antigos não traziam o provedor
  const def = PROVIDERS[kind];
  if (!def) throw new Error(`Provedor não suportado pelo Runner: ${String(kind)}`);

  const key = def.keyEnv ? env[def.keyEnv] : undefined;
  if (def.keyEnv && !key) throw new Error(`Defina ${def.keyEnv} no ambiente do Runner para usar agentes do provedor ${kind}`);

  if (def.kind === 'anthropic') return new AnthropicModelClient({ apiKey: key!, model: job.model });

  const baseRaw = (def.baseEnv ? env[def.baseEnv] : undefined) || def.defaultBase!;
  const baseURL = checkedUrl(baseRaw, def.baseEnv ?? 'URL base');
  return new OpenAiCompatModelClient({ kind: def.kind, model: job.model, baseURL, apiKey: key });
}

/** Resumo para a partida do Runner: o que está configurado, sem mostrar chave. */
export function providerCheck(env: Env = process.env): string[] {
  return Object.entries(PROVIDERS).map(([name, def]) => {
    if (!def.keyEnv) return `${name}: ${env[def.baseEnv ?? ''] || def.defaultBase} (local, sem chave)`;
    return `${name}: ${env[def.keyEnv] ? 'configurado' : `não configurado (defina ${def.keyEnv})`}`;
  });
}
