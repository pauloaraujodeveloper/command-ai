import type { JsonSchemaProp, ObjectSchema } from './types.ts';

/**
 * O modo estrito das ferramentas não aceita limites numéricos nem de tamanho no esquema.
 * Eles continuam valendo: o Runner valida cada entrada localmente (`validateInput`) antes de executar,
 * e o limite vai para a descrição para o modelo respeitá-lo.
 */
export function toApiProp(p: JsonSchemaProp): Record<string, unknown> {
  const hints: string[] = [];
  if (p.minimum !== undefined) hints.push(`mínimo ${p.minimum}`);
  if (p.maximum !== undefined) hints.push(`máximo ${p.maximum}`);
  if (p.maxLength !== undefined) hints.push(`até ${p.maxLength} caracteres`);
  if (p.minItems !== undefined) hints.push(`ao menos ${p.minItems} item(ns)`);
  if (p.maxItems !== undefined) hints.push(`no máximo ${p.maxItems} itens`);
  const description = [p.description, hints.length ? `(${hints.join(', ')})` : ''].filter(Boolean).join(' ');
  const out: Record<string, unknown> = { type: p.type, ...(description ? { description } : {}) };
  if (p.enum) out.enum = p.enum;
  if (p.type === 'array' && p.items) out.items = p.items.type === 'object' ? toApiObject(p.items) : toApiProp(p.items as JsonSchemaProp);
  return out;
}

export function toApiObject(s: ObjectSchema): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toApiProp(v)])),
    required: s.required,
    additionalProperties: false,
  };
}
