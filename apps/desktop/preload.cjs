'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Única ponte entre a página e o sistema: abrir o seletor de pasta e receber o caminho escolhido (ou null).
contextBridge.exposeInMainWorld('commandAIDesktop', {
  pickFolder: () => ipcRenderer.invoke('command-ai:pick-folder'),
});
