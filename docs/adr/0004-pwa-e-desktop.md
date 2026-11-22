# ADR 0004: PWA e app desktop

Status: aceita.

## Contexto

O produto precisa funcionar na web e também instalar em computador ou notebook.

## Decisão

1. **PWA** para instalação sem empacotar nada: manifesto, ícones (192, 512 e maskable), service worker e botão "Instalar no computador" que usa `beforeinstallprompt`.
2. **Electron** (`apps/desktop`) para quem quer um instalador de verdade (`.exe`, `.dmg`, `.AppImage`, `.deb`).

O desktop é um **cliente fino**: abre a URL do servidor e mais nada. Não embute a API nem o Runner.

- Janela com `contextIsolation`, `sandbox`, sem `nodeIntegration` e sem DevTools no app empacotado.
- Só navega dentro da origem do servidor; links externos abrem no navegador do sistema (apenas http e https).
- Nenhuma permissão de navegador (câmera, microfone, localização) é concedida.
- `http` só é aceito para localhost; servidores remotos exigem `https`. URL com usuário e senha embutidos é recusada.
- A API serve o app web na mesma origem com CSP própria (`script-src 'self'`, sem inline), e o service worker nunca intercepta `/api/`.

## Consequências

- Nada é assinado. O instalador NSIS do Windows não é gerado em máquinas com Smart App Control, porque o `electron-builder` executa o instalador sem assinatura para criar o desinstalador (ver RUNBOOK). Entrega provisória: `.zip`. Definitivo: certificado de assinatura de código ou build em CI.
- Sem atualização automática ainda.
- O Runner continua sendo um processo separado. Embutir o Runner no desktop é uma evolução natural (o app já roda na máquina do usuário), mas muda a superfície de ataque e merece decisão própria.
- O bundle do painel ficou em ~560 kB (166 kB comprimido) por causa do SDK do Neon Auth; dá para dividir em blocos depois.
