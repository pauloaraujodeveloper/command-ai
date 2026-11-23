const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAppUrl, isAllowedNavigation, isSafeExternalUrl, resolveAppUrl } = require('../config.cjs');

describe('normalizeAppUrl', () => {
  it('aceita https em qualquer host', () => {
    assert.equal(normalizeAppUrl('https://app.commandai.dev'), 'https://app.commandai.dev/');
  });

  it('aceita http só em localhost, 127.0.0.1 e [::1]', () => {
    assert.equal(normalizeAppUrl('http://localhost:3011'), 'http://localhost:3011/');
    assert.equal(normalizeAppUrl('http://127.0.0.1:3011'), 'http://127.0.0.1:3011/');
    assert.equal(normalizeAppUrl('http://[::1]:3011'), 'http://[::1]:3011/');
  });

  it('recusa http em host remoto (senha e cookie trafegariam sem criptografia)', () => {
    assert.throws(() => normalizeAppUrl('http://app.commandai.dev'), /https/i);
  });

  it('recusa esquemas perigosos e lixo', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'ftp://x.com', '', 'não é url']) {
      assert.throws(() => normalizeAppUrl(bad), undefined, bad);
    }
  });

  it('recusa host que só parece localhost', () => {
    assert.throws(() => normalizeAppUrl('http://localhost.evil.com'));
    assert.throws(() => normalizeAppUrl('http://127.0.0.1.evil.com'));
  });

  it('recusa credenciais embutidas na URL', () => {
    assert.throws(() => normalizeAppUrl('https://user:pass@app.commandai.dev'), /credenciais/i);
  });
});

describe('isAllowedNavigation', () => {
  const app = 'https://app.commandai.dev/';
  it('permite a mesma origem', () => {
    assert.equal(isAllowedNavigation('https://app.commandai.dev/execucoes/1', app), true);
  });
  it('bloqueia outra origem, outro esquema e outra porta', () => {
    assert.equal(isAllowedNavigation('https://evil.example/', app), false);
    assert.equal(isAllowedNavigation('http://app.commandai.dev/', app), false);
    assert.equal(isAllowedNavigation('https://app.commandai.dev:8443/', app), false);
    assert.equal(isAllowedNavigation('javascript:alert(1)', app), false);
  });
  it('permite a página local de erro de conexão', () => {
    assert.equal(isAllowedNavigation('file:///C:/app/offline.html?target=x', app, { offlineFile: 'C:/app/offline.html' }), true);
    assert.equal(isAllowedNavigation('file:///C:/outro.html', app, { offlineFile: 'C:/app/offline.html' }), false);
  });
});

describe('isSafeExternalUrl', () => {
  it('só abre https e http no navegador do sistema', () => {
    assert.equal(isSafeExternalUrl('https://neon.com/docs'), true);
    assert.equal(isSafeExternalUrl('http://example.com'), true);
    assert.equal(isSafeExternalUrl('file:///C:/Windows/System32/calc.exe'), false);
    assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
    assert.equal(isSafeExternalUrl('ms-msdt:/id'), false);
  });
});

describe('resolveAppUrl', () => {
  it('prioriza a variável de ambiente, depois o arquivo e por fim o padrão local', () => {
    assert.equal(resolveAppUrl({ env: 'https://a.example', file: 'https://b.example' }), 'https://a.example/');
    assert.equal(resolveAppUrl({ file: 'https://b.example' }), 'https://b.example/');
    assert.equal(resolveAppUrl({}), 'http://127.0.0.1:3011/');
  });
  it('propaga erro de uma URL inválida em vez de cair no padrão em silêncio', () => {
    assert.throws(() => resolveAppUrl({ env: 'http://remoto.example' }));
  });
});

describe('seletor de pasta (só para a página do próprio servidor)', () => {
  const { isTrustedSender, folderFromDialog } = require('../config.cjs');

  it('confia só em quem está na origem do servidor configurado', () => {
    assert.equal(isTrustedSender('http://127.0.0.1:3011/projetos', 'http://127.0.0.1:3011/'), true);
    assert.equal(isTrustedSender('https://app.exemplo.com/x', 'https://app.exemplo.com/'), true);
  });

  it('recusa outra origem, porta diferente, esquema diferente, file:// e lixo', () => {
    for (const bad of ['https://evil.example/', 'http://127.0.0.1:9999/', 'https://127.0.0.1:3011/', 'file:///C:/offline.html', 'about:blank', '', undefined, null, 'não é url']) {
      assert.equal(isTrustedSender(bad, 'http://127.0.0.1:3011/'), false, String(bad));
    }
  });

  it('devolve a primeira pasta escolhida, ou null se cancelou ou veio vazio', () => {
    assert.equal(folderFromDialog({ canceled: false, filePaths: ['C:\proj\site'] }), 'C:\proj\site');
    assert.equal(folderFromDialog({ canceled: true, filePaths: ['C:/x'] }), null);
    assert.equal(folderFromDialog({ canceled: false, filePaths: [] }), null);
    assert.equal(folderFromDialog(undefined), null);
    assert.equal(folderFromDialog({ canceled: false, filePaths: [123] }), null);
  });
});
