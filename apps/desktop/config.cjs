'use strict';

/**
 * Regras de segurança do app desktop, sem depender do Electron (testáveis com `node --test`).
 * O desktop é um cliente fino: ele só abre a URL do servidor Command AI configurado.
 */

const DEFAULT_URL = 'http://127.0.0.1:3011';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Valida e normaliza a URL do servidor. https em qualquer host; http só em loopback. */
function normalizeAppUrl(input) {
  let url;
  try {
    url = new URL(String(input ?? '').trim());
  } catch {
    throw new Error(`URL do servidor inválida: "${input}"`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Esquema não permitido: ${url.protocol} (use https)`);
  }
  if (url.username || url.password) {
    throw new Error('A URL não pode conter credenciais embutidas.');
  }
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error('Servidores remotos precisam usar https (http só vale para localhost).');
  }
  return url.toString();
}

/** Ordem: variável de ambiente, arquivo de configuração e, por fim, o servidor local. */
function resolveAppUrl({ env, file } = {}) {
  return normalizeAppUrl(env || file || DEFAULT_URL);
}

function fileUrlToPath(u) {
  return decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, '$1');
}

/** A janela só pode navegar dentro da origem do servidor (e para a página local de erro). */
function isAllowedNavigation(target, appUrl, opts = {}) {
  let t;
  let a;
  try {
    t = new URL(target);
    a = new URL(appUrl);
  } catch {
    return false;
  }
  if (t.protocol === 'file:') {
    return Boolean(opts.offlineFile) && fileUrlToPath(t).toLowerCase() === String(opts.offlineFile).replace(/\\/g, '/').toLowerCase();
  }
  return t.origin === a.origin;
}

/** Links para fora do app abrem no navegador do sistema, e só se forem http(s). */
function isSafeExternalUrl(target) {
  try {
    const { protocol } = new URL(target);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

module.exports = { DEFAULT_URL, normalizeAppUrl, resolveAppUrl, isAllowedNavigation, isSafeExternalUrl };
